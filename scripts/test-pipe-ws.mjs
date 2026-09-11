#!/usr/bin/env node
/*
 * test-pipe-ws.mjs
 *
 * Standalone test runner for src/pipe-ws.js. No test framework: it prints
 * "PASS <name>" / "FAIL <name>: <reason>" per case, a machine readable
 * "SUMMARY pass=<n> fail=<n>" last line, and exits 1 when anything failed.
 *
 * Usage: node scripts/test-pipe-ws.mjs
 *
 * How the browser is faked: the shim source is evaluated with node:vm in a
 * fresh context whose globals are 'window' (the iframe side) and 'parent' (the
 * embedding DSH web UI). Each fake port is an EventTarget; postMessage
 * dispatches the 'message' event on the port itself, which mirrors the browser
 * semantics of window.parent.postMessage(...) (delivered to the parent window)
 * and iframe.contentWindow.postMessage(...) (delivered to the iframe). The shim
 * listens on 'window' and posts to 'parent', so the test server under 'parent'
 * sees every message the shim emits and answers through 'window'.
 *
 * The server below is a deliberately independent minimal RFC6455
 * implementation (its own handshake accept computation and its own frame codec,
 * sharing no code with the shim), so every case is a two-implementation
 * interop test rather than a self-consistency check.
 */

import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = join(HERE, '..', 'src', 'pipe-ws.js');
const SHIM_SOURCE = readFileSync(SHIM_PATH, 'utf8');

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_URL = 'ws://app:0/stable-abc123?reconnectionToken=xyz&skipWebSocketFrames=false';
// The shim is a raw-byte client (no VS Code deflate frame layer), so it must ask the
// server to skip ITS frame layer too. Regression guard for the reconnect storm:
// with skipWebSocketFrames=false the server wraps the socket and the client cannot parse it.
const EXPECTED_PATH = '/stable-abc123?reconnectionToken=xyz&skipWebSocketFrames=true';
const DECODER = new TextDecoder('utf-8');

/* ------------------------------------------------------------------ *
 * Fake browser ports
 * ------------------------------------------------------------------ */

class FakePort extends EventTarget {
  constructor(name) {
    super();
    this.name = name;
    this.received = [];
  }

  postMessage(data, origin, transfer) {
    this.received.push({ data, origin, transfer: transfer || [] });
    const event = new Event('message');
    Object.defineProperty(event, 'data', { value: data, enumerable: true, configurable: true });
    Object.defineProperty(event, 'origin', {
      value: origin === undefined ? '*' : origin,
      enumerable: true,
      configurable: true,
    });
    this.dispatchEvent(event);
    return true;
  }
}

/* ------------------------------------------------------------------ *
 * Load the shim into a browserless vm sandbox
 * ------------------------------------------------------------------ */

const sandbox = {
  window: null,
  parent: null,
  crypto: webcrypto,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  ArrayBuffer,
  DataView,
  setTimeout,
  clearTimeout,
  console,
  // The shim prefers the WHATWG URL parser; a real browser always has it, so
  // the test provides it (the shim also has a fallback for host-less contexts).
  URL,
};
vm.runInNewContext(SHIM_SOURCE, sandbox, { filename: 'src/pipe-ws.js' });

const factory = sandbox.__DSH_WS_FACTORY__;
if (!factory || typeof factory.create !== 'function') {
  console.log('FAIL load: globalThis.__DSH_WS_FACTORY__.create is missing');
  console.log('SUMMARY pass=0 fail=1');
  process.exit(1);
}

function newEnv() {
  const parent = new FakePort('parent');
  const win = new FakePort('window');
  sandbox.window = win;
  sandbox.parent = parent;
  return {
    parent,
    win,
    server(options = {}) {
      return new TestServer({ listen: parent, win, ...options });
    },
    socket(label) {
      return factory.create(WS_URL, label === undefined ? 'test-label' : label);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Independent minimal RFC6455 server (test side)
 * ------------------------------------------------------------------ */

function sha1Base64(text) {
  return createHash('sha1').update(text, 'utf8').digest('base64');
}

function buildServerFrame(opcode, payloadBytes, fin = true) {
  const body = Buffer.from(payloadBytes);
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0x00) | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    header[1] = 127;
    header.writeUInt32BE(Math.floor(length / 4294967296), 2);
    header.writeUInt32BE(length >>> 0, 6);
  }
  return Buffer.concat([header, body]);
}

// Only used for the negative case: the shim must reject masked server frames.
function buildMaskedServerFrame(opcode, payloadBytes) {
  const body = Buffer.from(payloadBytes);
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | body.length]), mask, masked]);
}

function buildCloseBody(code, reason) {
  const reasonBytes = Buffer.from(reason || '', 'utf8');
  const body = Buffer.alloc(2 + reasonBytes.length);
  body.writeUInt16BE(code, 0);
  reasonBytes.copy(body, 2);
  return body;
}

// Client-to-server frame decoder: validates masking, unmasks, and returns every
// complete frame found in conn.buffer.
function decodeClientFrames(conn) {
  const frames = [];
  const buf = conn.buffer;
  let offset = 0;
  for (;;) {
    if (buf.length - offset < 2) break;
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buf.length - cursor < 2) break;
      length = buf.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buf.length - cursor < 8) break;
      length = buf.readUInt32BE(cursor) * 4294967296 + buf.readUInt32BE(cursor + 4);
      cursor += 8;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length - cursor < 4) break;
      maskKey = Buffer.from(buf.subarray(cursor, cursor + 4));
      cursor += 4;
    }
    if (buf.length - cursor < length) break;
    const payload = Buffer.from(buf.subarray(cursor, cursor + length));
    if (masked) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    cursor += length;
    offset = cursor;
    frames.push({ fin, rsv, opcode, masked, maskKey, payload });
  }
  conn.buffer = Buffer.from(buf.subarray(offset));
  return frames;
}

function recordClientFrame(conn, frame) {
  conn.frames.push(frame);
  if (frame.opcode === 0x1 || frame.opcode === 0x2) {
    if (frame.fin) {
      conn.messages.push(frame.payload);
    } else {
      conn.fragmentOpcode = frame.opcode;
      conn.fragmentChunks = [frame.payload];
    }
    return;
  }
  if (frame.opcode === 0x0) {
    if (!conn.fragmentChunks) throw new Error('server: continuation without a start frame');
    conn.fragmentChunks.push(frame.payload);
    if (frame.fin) {
      conn.messages.push(Buffer.concat(conn.fragmentChunks));
      conn.fragmentChunks = null;
    }
  }
}

class TestServer {
  constructor({ listen, win, mode = 'ok', echoClosedOnClose = false }) {
    this.listen = listen;
    this.win = win;
    this.mode = mode;
    this.echoClosedOnClose = echoClosedOnClose;
    this.connections = new Map();
    this.openMessages = [];
    this.closeMessages = [];
    this.framesFromClient = [];
    this.handler = (event) => this.handle(event.data);
    this.listen.addEventListener('message', this.handler);
  }

  dispose() {
    this.listen.removeEventListener('message', this.handler);
  }

  handle(data) {
    if (!data || typeof data !== 'object' || data.__dshcs !== 1) return;
    if (data.kind === 'open') {
      this.handleOpen(data);
      return;
    }
    if (data.kind === 'frame') {
      this.handleFrame(data);
      return;
    }
    if (data.kind === 'close') {
      this.closeMessages.push(data);
      const conn = this.connections.get(data.id);
      if (conn) conn.parentClosed = true;
      // A real parent tears the tunnel down when it sees kind:'close' and may
      // report that back. Doing it synchronously here (the harshest ordering)
      // makes the shim's close sequencing observable.
      if (this.echoClosedOnClose && conn) this.sendTunnelClosed(conn);
    }
  }

  handleOpen(data) {
    this.openMessages.push(data);
    const conn = {
      id: data.id,
      path: data.path,
      key: data.key,
      version: data.version,
      debugLabel: data.debugLabel,
      buffer: Buffer.alloc(0),
      frames: [],
      messages: [],
      fragmentChunks: null,
      fragmentOpcode: 0,
      parentClosed: false,
    };
    this.connections.set(conn.id, conn);
    if (this.mode === 'garbage-headers') {
      // Never sends CRLFCRLF, so the shim must give up on its own bound.
      this.sendBytes(conn, Buffer.alloc(72 * 1024, 0x41));
      return;
    }
    const accept =
      this.mode === 'bad-accept'
        ? sha1Base64('definitely-not-the-key')
        : sha1Base64(String(data.key) + MAGIC);
    const head =
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n';
    this.sendBytes(conn, Buffer.from(head, 'ascii'));
  }

  handleFrame(data) {
    const conn = this.connections.get(data.id);
    if (!conn) throw new Error('server: frame for an unknown connection id');
    const bytes = data.buf instanceof ArrayBuffer
      ? Buffer.from(new Uint8Array(data.buf))
      : Buffer.from(data.buf);
    conn.buffer = Buffer.concat([conn.buffer, bytes]);
    const frames = decodeClientFrames(conn);
    for (const frame of frames) {
      this.framesFromClient.push(frame);
      recordClientFrame(conn, frame);
    }
  }

  sendBytes(conn, buf) {
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    this.win.postMessage({ __dshcs: 1, id: conn.id, kind: 'data', buf: ab }, '*', [ab]);
  }

  sendFrame(conn, opcode, payload, fin = true) {
    this.sendBytes(conn, buildServerFrame(opcode, payload, fin));
  }

  sendRaw(conn, buf) {
    this.sendBytes(conn, buf);
  }

  sendTunnelError(conn, message) {
    this.win.postMessage({ __dshcs: 1, id: conn.id, kind: 'error', message }, '*');
  }

  sendTunnelClosed(conn) {
    this.win.postMessage({ __dshcs: 1, id: conn.id, kind: 'closed' }, '*');
  }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) await tick();
}

function record(socket) {
  const rec = { data: [], open: 0, close: [], error: [], badData: null };
  socket.onData((buf) => {
    if (buf instanceof ArrayBuffer) rec.data.push(new Uint8Array(buf));
    else {
      rec.badData = buf;
      rec.data.push(null);
    }
  });
  socket.onOpen(() => {
    rec.open += 1;
  });
  socket.onClose((event) => rec.close.push(event));
  socket.onError((err) => rec.error.push(err));
  return rec;
}

function pattern(length, seed = 1) {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    out[i] = (state >>> 16) & 0xff;
  }
  return out;
}

function bytesProblem(actual, expected) {
  if (!actual) return 'no data received';
  if (actual.length !== expected.length) {
    return 'length ' + actual.length + ' !== ' + expected.length;
  }
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      return 'byte ' + i + ': ' + actual[i] + ' !== ' + expected[i];
    }
  }
  return null;
}

function expectBytes(actual, expected, label) {
  const problem = bytesProblem(actual, expected);
  if (problem) throw new Error(label + ': ' + problem);
}

function onlyConnection(server) {
  assert.equal(server.connections.size, 1, 'server should own exactly one connection');
  return server.connections.values().next().value;
}

/* ------------------------------------------------------------------ *
 * Cases
 * ------------------------------------------------------------------ */

const results = [];
let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    passCount++;
    results.push({ name, ok: true });
    console.log('PASS ' + name);
  } catch (err) {
    failCount++;
    const reason = err && err.message ? err.message : String(err);
    results.push({ name, ok: false, reason });
    console.log('FAIL ' + name + ': ' + reason);
    if (process.env.DSH_TEST_VERBOSE) console.log(err && err.stack ? err.stack : '');
  }
}

await test('handshake: tunnel open request is posted and onOpen fires once', async () => {
  const env = newEnv();
  const server = env.server();
  const socket = env.socket('label-a');
  const rec = record(socket);
  await flush();

  assert.equal(rec.open, 1, 'onOpen should fire exactly once');
  assert.equal(rec.error.length, 0, 'no onError expected');
  assert.equal(server.openMessages.length, 1, 'parent should receive one open message');
  const open = server.openMessages[0];
  assert.equal(open.kind, 'open');
  assert.equal(open.path, EXPECTED_PATH, 'path must be pathname + search, with skipWebSocketFrames forced to true');
  assert.equal(open.version, '13', 'version must be 13');
  assert.equal(open.debugLabel, 'label-a');
  assert.equal(typeof open.id, 'string');
  assert.ok(open.id.length > 0, 'id must be a non empty string');
  const keyBytes = Buffer.from(String(open.key), 'base64');
  assert.equal(keyBytes.length, 16, 'Sec-WebSocket-Key must be 16 random bytes');

  socket.close();
  await flush();
  server.dispose();
});

await test('handshake: a wrong Sec-WebSocket-Accept produces onError', async () => {
  const env = newEnv();
  const server = env.server({ mode: 'bad-accept' });
  const socket = env.socket('bad-accept');
  const rec = record(socket);
  await flush();

  assert.equal(rec.open, 0, 'onOpen must not fire on a bad accept header');
  assert.equal(rec.error.length, 1, 'onError should fire once');
  assert.ok(
    /accept/i.test(String(rec.error[0] && rec.error[0].message)),
    'error message should mention the accept header, got: ' + String(rec.error[0] && rec.error[0].message),
  );
  assert.equal(rec.close.length, 1, 'the failed socket should close with 1006');
  assert.equal(rec.close[0].code, 1006);
  assert.equal(rec.close[0].wasClean, false);
  assert.ok(server.closeMessages.length >= 1, 'the parent should be told to tear the tunnel down');

  socket.close();
  await flush();
  assert.equal(rec.close.length, 1, 'close() after a handshake failure must not fire onClose again');
  server.dispose();
});

await test('send: new Uint8Array([1,2,3]).buffer arrives masked and unmasked correctly', async () => {
  const env = newEnv();
  const server = env.server();
  const socket = env.socket();
  const rec = record(socket);
  await flush();

  socket.send(new Uint8Array([1, 2, 3]).buffer);
  await flush();

  const conn = onlyConnection(server);
  assert.equal(conn.frames.length, 1, 'exactly one client frame expected');
  const frame = conn.frames[0];
  assert.equal(frame.opcode, 0x2, 'send() must emit a binary frame');
  assert.equal(frame.fin, true, 'send() must emit a single FIN frame');
  assert.equal(frame.masked, true, 'client frames must be masked');
  assert.equal(frame.rsv, 0, 'reserved bits must be clear');
  expectBytes(frame.payload, Buffer.from([1, 2, 3]), 'payload after unmasking');
  assert.equal(rec.error.length, 0, 'no onError expected');

  socket.close();
  await flush();
  server.dispose();
});

await test('send: a 300 byte payload round-trips through the 16 bit length path', async () => {
  const env = newEnv();
  const server = env.server();
  const socket = env.socket();
  record(socket);
  await flush();

  const payload = pattern(300, 7);
  socket.send(payload.buffer.slice(0));
  await flush();

  const conn = onlyConnection(server);
  assert.equal(conn.frames.length, 1, 'exactly one client frame expected');
  expectBytes(conn.frames[0].payload, payload, '300 byte payload');
  assert.equal(conn.messages.length, 1, 'the server should have assembled one message');
  expectBytes(conn.messages[0], payload, '300 byte message');

  socket.close();
  await flush();
  server.dispose();
});

await test('send: payloads sent before onOpen are buffered and flushed after open', async () => {
  const env = newEnv();
  const server = env.server();
  const socket = env.socket();
  const rec = record(socket);

  // No flush yet: the socket is still in the handshake, so this must be queued.
  const early = new Uint8Array([42, 43, 44, 45]);
  socket.send(early.buffer);
  await flush();

  assert.equal(rec.open, 1, 'the handshake should have completed');
  const conn = onlyConnection(server);
  assert.equal(conn.frames.length, 1, 'the buffered payload must be flushed exactly once');
  expectBytes(conn.frames[0].payload, early, 'buffered payload');
  expectBytes(early, new Uint8Array([42, 43, 44, 45]), 'the caller buffer must stay intact');
  assert.equal(rec.error.length, 0, 'no onError expected');

  socket.close();
  await flush();
  server.dispose();
});

await test('receive: 5 byte, 200 byte, 64 KiB and fragmented frames arrive byte identical and in order', async () => {
  const env = newEnv();
  const server = env.server();
  const socket = env.socket();
  const rec = record(socket);
  await flush();
  const conn = onlyConnection(server);

  const small = pattern(5, 11);
  const medium = pattern(200, 22);
  const large = pattern(64 * 1024, 33);
  const fragA = pattern(4096, 44);
  const fragB = pattern(1024, 55);

  // Two complete frames in a single tunnel chunk.
  server.sendRaw(conn, Buffer.concat([buildServerFrame(0x2, small), buildServerFrame(0x2, medium)]));
  // A 64 KiB frame (64 bit extended length on the wire).
  server.sendFrame(conn, 0x2, large);
  // A fragmented message: start frame + continuation, both in one chunk.
  server.sendRaw(
    conn,
    Buffer.concat([buildServerFrame(0x2, fragA, false), buildServerFrame(0x0, fragB, true)]),
  );
  await flush(20);

  assert.equal(rec.open, 1, 'the handshake should have completed');
  assert.equal(rec.badData, null, 'onData must deliver ArrayBuffers');
  assert.equal(rec.error.length, 0, 'no onError expected');
  assert.equal(rec.data.length, 4, 'expected 4 messages, got ' + rec.data.length);
  expectBytes(rec.data[0], small, '5 byte frame');
  expectBytes(rec.data[1], medium, '200 byte frame');
  expectBytes(rec.data[2], large, '64 KiB frame');
  const assembled = new Uint8Array(fragA.length + fragB.length);
  assembled.set(fragA, 0);
  assembled.set(fragB, fragA.length);
  expectBytes(rec.data[3], assembled, 'fragmented message');

  socket.close();
  await flush();
  server.dispose();
});

await test('ping: the shim answers with a masked pong that echoes the payload', async () => {
  const env = newEnv();
  const server = env.server();
  const socket = env.socket();
  const rec = record(socket);
  await flush();
  const conn = onlyConnection(server);

  const pingPayload = Buffer.from([9, 8, 7, 6]);
  server.sendFrame(conn, 0x9, pingPayload);
  await flush();

  assert.equal(rec.error.length, 0, 'no onError expected');
  assert.equal(conn.frames.length, 1, 'the shim should answer the ping with one frame');
  const pong = conn.frames[0];
  assert.equal(pong.opcode, 0xa, 'the answer must be a pong (0xA), got 0x' + pong.opcode.toString(16));
  assert.equal(pong.masked, true, 'client frames must be masked');
  expectBytes(pong.payload, pingPayload, 'pong payload must echo the ping payload');
  assert.equal(rec.data.length, 0, 'a ping must not surface as data');
  assert.equal(rec.close.length, 0, 'a ping must not close the socket');

  socket.close();
  await flush();
  server.dispose();
});

await test('close frame: server close 4000/bye is reported exactly once as clean', async () => {
  const env = newEnv();
  const server = env.server();
  const socket = env.socket();
  const rec = record(socket);
  await flush();
  const conn = onlyConnection(server);

  server.sendFrame(conn, 0x8, buildCloseBody(4000, 'bye'));
  await flush();

  assert.equal(rec.close.length, 1, 'onClose must fire exactly once, got ' + rec.close.length);
  const event = rec.close[0];
  assert.equal(event.code, 4000, 'close code');
  assert.equal(event.reason, 'bye', 'close reason');
  assert.equal(event.wasClean, true, 'the remote close is clean');
  assert.ok(event.event, 'the close event should carry the underlying event payload');

  assert.ok(
    server.closeMessages.some((msg) => msg.id === conn.id),
    'the shim must post { __dshcs: 1, kind: "close", id } to the parent',
  );
  const closeFrame = conn.frames.find((frame) => frame.opcode === 0x8);
  assert.ok(closeFrame, 'the shim must echo a close frame');
  assert.equal(closeFrame.masked, true, 'the echo close frame must be masked');
  assert.equal(closeFrame.payload.readUInt16BE(0), 4000, 'the echo close frame should carry code 4000');

  // Nothing may be delivered or reported after the close.
  server.sendFrame(conn, 0x2, Buffer.from('after-close'));
  server.sendTunnelClosed(conn);
  await flush();
  assert.equal(rec.close.length, 1, 'onClose must not fire twice');
  assert.equal(rec.data.length, 0, 'no data may be delivered after close');
  socket.close();
  await flush();
  assert.equal(rec.close.length, 1, 'close() after a remote close must be a no-op');
  server.dispose();
});

await test('close frame: a parent echoing kind:"closed" cannot preempt the remote close code', async () => {
  const env = newEnv();
  const server = env.server({ echoClosedOnClose: true });
  const socket = env.socket();
  const rec = record(socket);
  await flush();
  const conn = onlyConnection(server);

  server.sendFrame(conn, 0x8, buildCloseBody(4000, 'bye'));
  await flush();

  assert.equal(rec.close.length, 1, 'onClose must fire exactly once, got ' + rec.close.length);
  assert.equal(rec.close[0].code, 4000, 'the remote close code must win over the parent echo');
  assert.equal(rec.close[0].reason, 'bye', 'the remote close reason must win over the parent echo');
  assert.equal(rec.close[0].wasClean, true);

  socket.close();
  await flush();
  assert.equal(rec.close.length, 1, 'close() after the remote close must be a no-op');
  server.dispose();
});

await test('close(): an open socket sends a masked 1000 close frame and reports a clean close once', async () => {
  const env = newEnv();
  const server = env.server({ echoClosedOnClose: true });
  const socket = env.socket();
  const rec = record(socket);
  await flush();
  const conn = onlyConnection(server);

  socket.close();
  await flush();

  assert.equal(rec.close.length, 1, 'onClose must fire exactly once');
  assert.equal(rec.close[0].code, 1000, 'a local close is code 1000');
  assert.equal(rec.close[0].reason, '', 'a local close carries no reason');
  assert.equal(rec.close[0].wasClean, true, 'a local close is clean');
  assert.equal(rec.error.length, 0, 'no onError expected');

  const closeFrame = conn.frames.find((frame) => frame.opcode === 0x8);
  assert.ok(closeFrame, 'close() must send a close frame');
  assert.equal(closeFrame.masked, true, 'the close frame must be masked');
  assert.equal(closeFrame.fin, true, 'control frames must not be fragmented');
  assert.equal(closeFrame.payload.readUInt16BE(0), 1000, 'the close frame must carry code 1000');
  assert.ok(
    server.closeMessages.some((msg) => msg.id === conn.id),
    'the parent must be told to close the tunnel',
  );

  socket.close();
  socket.close();
  await flush();
  assert.equal(rec.close.length, 1, 'close() must stay idempotent');
  server.dispose();
});

await test('close(): before open and twice in a row are both safe', async () => {
  const env = newEnv();
  const server = env.server();
  const socket = env.socket();
  const rec = record(socket);

  // No flush here: the handshake response has not been processed yet.
  socket.close();
  socket.close();

  assert.equal(rec.close.length, 1, 'close() must fire onClose exactly once');
  assert.equal(rec.close[0].wasClean, false, 'closing before open is not a clean close');
  assert.ok(rec.error.length + rec.close.length >= 1, 'the socket reported the shutdown');

  await flush();
  assert.equal(rec.open, 0, 'the socket must not open after close()');
  assert.equal(rec.close.length, 1, 'close() must stay idempotent across ticks');

  socket.send(new Uint8Array([1, 2, 3]).buffer);
  socket.close();
  await flush();

  assert.equal(rec.close.length, 1, 'close() after close() must not fire again');
  assert.ok(server.closeMessages.length >= 1, 'the parent must be told to close the tunnel');
  const conn = server.connections.get(server.openMessages[0].id);
  assert.ok(conn, 'the parent saw the open request before the local close');
  assert.equal(conn.frames.length, 0, 'send() after close must not emit a frame');
  server.dispose();
});

await test('rfc6455 5.7: the shim emits a decodable masked single-frame "Hello"', async () => {
  const env = newEnv();
  const server = env.server();
  const socket = env.socket();
  record(socket);
  await flush();

  socket.send(new TextEncoder().encode('Hello').buffer);
  await flush();

  const conn = onlyConnection(server);
  assert.equal(conn.frames.length, 1, 'exactly one client frame expected');
  const frame = conn.frames[0];
  assert.equal(frame.fin, true, 'single frame');
  assert.equal(frame.masked, true, 'masked');
  assert.equal(frame.opcode, 0x2, 'send() emits binary frames (0x2)');
  assert.equal(frame.payload.toString('latin1'), 'Hello', 'independent parser must decode "Hello"');

  // The same parser must handle the RFC 5.7 canonical masked text vector.
  const vector = Buffer.from([
    0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58,
  ]);
  const vectorConn = { buffer: vector, frames: [], messages: [], fragmentChunks: null };
  const vectorFrames = decodeClientFrames(vectorConn);
  assert.equal(vectorFrames.length, 1, 'the RFC vector is one frame');
  assert.equal(vectorFrames[0].opcode, 0x1, 'the RFC vector is a text frame');
  assert.equal(vectorFrames[0].masked, true, 'the RFC vector is masked');
  assert.equal(vectorFrames[0].payload.toString('latin1'), 'Hello', 'RFC vector payload');
  assert.equal(vectorConn.buffer.length, 0, 'the RFC vector is fully consumed');

  socket.close();
  await flush();
  server.dispose();
});

await test('rfc6455 5.7: an unmasked single-frame "Hello" from the server decodes in the shim', async () => {
  const env = newEnv();
  const server = env.server();
  const socket = env.socket();
  const rec = record(socket);
  await flush();
  const conn = onlyConnection(server);

  server.sendRaw(conn, Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]));
  await flush();

  assert.equal(rec.error.length, 0, 'no onError expected');
  assert.equal(rec.data.length, 1, 'expected one message, got ' + rec.data.length);
  expectBytes(rec.data[0], Buffer.from('Hello', 'latin1'), 'unmasked text frame');

  socket.close();
  await flush();
  server.dispose();
});

await test('tunnel: { kind: "error" } from the parent fires onError', async () => {
  const env = newEnv();
  const server = env.server({ echoClosedOnClose: true });
  const socket = env.socket();
  const rec = record(socket);
  await flush();
  const conn = onlyConnection(server);

  server.sendTunnelError(conn, 'tunnel exploded');
  await flush();

  assert.equal(rec.error.length, 1, 'onError should fire once');
  assert.equal(rec.error[0].message, 'tunnel exploded', 'the tunnel message must be preserved');
  assert.equal(rec.close.length, 1, 'the socket closes after a tunnel error');
  assert.equal(rec.close[0].code, 1006);

  socket.close();
  await flush();
  server.dispose();
});

await test('tunnel: { kind: "closed" } from the parent reports 1006 tunnel closed', async () => {
  const env = newEnv();
  const server = env.server();
  const socket = env.socket();
  const rec = record(socket);
  await flush();
  const conn = onlyConnection(server);

  server.sendTunnelClosed(conn);
  await flush();

  assert.equal(rec.close.length, 1, 'onClose should fire once');
  assert.equal(rec.close[0].code, 1006, 'close code');
  assert.equal(rec.close[0].reason, 'tunnel closed', 'close reason');
  assert.equal(rec.close[0].wasClean, false, 'a dropped tunnel is not clean');

  socket.close();
  await flush();
  assert.equal(rec.close.length, 1, 'close() after a tunnel close must be a no-op');
  server.dispose();
});

await test('protocol: a masked server frame is rejected with onError', async () => {
  const env = newEnv();
  const server = env.server();
  const socket = env.socket();
  const rec = record(socket);
  await flush();
  const conn = onlyConnection(server);

  server.sendRaw(conn, buildMaskedServerFrame(0x2, Buffer.from([1, 2, 3])));
  await flush();

  assert.equal(rec.data.length, 0, 'a masked server frame must not be delivered');
  assert.equal(rec.error.length, 1, 'onError should fire once');
  assert.ok(
    /masked/i.test(String(rec.error[0] && rec.error[0].message)),
    'the error should mention masking, got: ' + String(rec.error[0] && rec.error[0].message),
  );
  assert.equal(rec.close.length, 1, 'the socket closes after a protocol error');

  socket.close();
  await flush();
  server.dispose();
});

await test('traceSocketEvent: records into a bounded ring only when __DSH_WS_DEBUG__ is set', async () => {
  const env = newEnv();
  const server = env.server();
  const socket = env.socket();
  record(socket);

  const before = factory.traceDump().length;
  socket.traceSocketEvent('ignored', 1);
  assert.equal(factory.traceDump().length, before, 'nothing may be recorded while the debug flag is unset');

  sandbox.__DSH_WS_DEBUG__ = true;
  await flush();
  assert.ok(
    factory.traceDump().some((entry) => entry.type === 'open'),
    'the completed handshake should be traced once the flag is set',
  );

  for (let i = 0; i < 40; i++) socket.traceSocketEvent('fill', i);
  const dump = factory.traceDump();
  assert.equal(dump.length, 32, 'the ring must hold the last 32 entries, got ' + dump.length);
  assert.equal(dump[dump.length - 1].type, 'fill');
  assert.equal(dump[dump.length - 1].data, 39, 'the newest entry must be last');
  assert.equal(dump[0].data, 8, 'the oldest retained entry must be entry 8');
  delete sandbox.__DSH_WS_DEBUG__;

  socket.close();
  await flush();
  server.dispose();
});

await test('limits: an oversized handshake response fails cleanly instead of buffering forever', async () => {
  const env = newEnv();
  const server = env.server({ mode: 'garbage-headers' });
  const socket = env.socket();
  const rec = record(socket);
  await flush();

  assert.equal(rec.open, 0, 'a header-less response must never open');
  assert.equal(rec.error.length, 1, 'onError should fire once');
  assert.ok(
    /handshake/i.test(String(rec.error[0] && rec.error[0].message)),
    'the error should mention the handshake, got: ' + String(rec.error[0] && rec.error[0].message),
  );
  assert.equal(rec.close.length, 1, 'the socket closes after the handshake limit is hit');

  socket.close();
  await flush();
  server.dispose();
});

await test('limits: outbound bytes queued before open are bounded at 16 MiB', async () => {
  const env = newEnv();
  const server = env.server();
  const socket = env.socket();
  const rec = record(socket);

  const megabyte = new Uint8Array(1024 * 1024);
  for (let i = 0; i < 16; i++) socket.send(megabyte.buffer);
  assert.equal(rec.error.length, 0, '16 MiB of queued payloads must be accepted');

  socket.send(megabyte.buffer);
  assert.equal(rec.error.length, 1, 'the 17th MiB must trip the outbound bound');
  assert.ok(
    /outbound buffer/i.test(String(rec.error[0] && rec.error[0].message)),
    'the error should mention the outbound buffer, got: ' + String(rec.error[0] && rec.error[0].message),
  );
  assert.equal(rec.close.length, 1, 'the socket fails cleanly');

  await flush();
  const conn = onlyConnection(server);
  assert.equal(conn.frames.length, 0, 'nothing may reach the tunnel after the failure');
  assert.equal(rec.open, 0, 'the socket must not open after failing');
  server.dispose();
});

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

console.log('SUMMARY pass=' + passCount + ' fail=' + failCount);
process.exitCode = failCount === 0 ? 0 : 1;
