// scripts/test-pipe-ws.mjs —— src/pipe-ws.js(裸字节隧道客户端)的离线测试
//
// 契约:隧道是**裸字节通道**(服务端被要求 skipWebSocketFrames=true),客户端除消费
// HTTP 101 外不做任何分帧。用法:node scripts/test-pipe-ws.mjs
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SHIM_SOURCE = readFileSync(new URL('../src/pipe-ws.js', import.meta.url), 'utf8');
const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_URL = 'ws://app:0/stable-abc123?reconnectionToken=xyz&reconnection=false&skipWebSocketFrames=false';
const EXPECTED_PATH = '/stable-abc123?reconnectionToken=xyz&reconnection=false&skipWebSocketFrames=true';

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await Promise.race([fn(), new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout 5s')), 5000))]);
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
}

/** shim 沙箱 + 父窗口桩(记录 shim 发出的消息,并能向 shim 投递消息)。 */
function makeHarness() {
  const toShim = new Set();
  const toParent = new Set();
  const iframeWindow = {
    addEventListener: (type, fn) => { if (type === 'message') toShim.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'message') toShim.delete(fn); },
    postMessage: (m) => { for (const fn of toShim) fn({ data: m }); },
  };
  const parentWindow = {
    addEventListener: (type, fn) => { if (type === 'message') toParent.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'message') toParent.delete(fn); },
    postMessage: (m) => { for (const fn of toParent) fn({ data: m }); },
  };
  iframeWindow.parent = parentWindow;
  const context = vm.createContext({
    window: iframeWindow, parent: parentWindow,
    crypto: { getRandomValues: (a) => webcrypto.getRandomValues(a), subtle: webcrypto.subtle },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    URL, URLSearchParams,
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, Error, Promise, Math, String, Number, JSON,
    setTimeout, clearTimeout, console,
  });
  vm.runInContext(SHIM_SOURCE, context);

  const received = { open: [], frames: [], close: 0 };
  toParent.add((event) => {
    const m = event.data;
    if (m === null || typeof m !== 'object' || m.__dshcs !== 1) return;
    if (m.kind === 'open') received.open.push(m);
    else if (m.kind === 'frame') received.frames.push(Buffer.from(m.buf));
    else if (m.kind === 'close') received.close += 1;
  });

  const socket = context.__DSH_WS_FACTORY__.create(WS_URL, 'label-a');
  const events = { data: [], open: 0, close: [], error: [] };
  socket.onData((buf) => events.data.push(Buffer.from(buf)));
  socket.onOpen(() => { events.open += 1; });
  socket.onClose((e) => events.close.push(e));
  socket.onError((e) => events.error.push(String(e && e.message ? e.message : e)));

  const id = () => received.open[0].id;
  /** 隧道响应体(服务端 → 客户端)。 */
  function serverPush(bytes) {
    const buf = Buffer.from(bytes);
    const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    iframeWindow.postMessage({ __dshcs: 1, kind: 'data', id: id(), buf: copy });
  }
  /** 父窗口 → shim 的任意消息。 */
  function pushToShim(message) {
    iframeWindow.postMessage({ __dshcs: 1, id: id(), ...message });
  }
  function handshake101(mode = 'good') {
    const accept = mode === 'bad' ? 'wrong-accept' : createHash('sha1').update(received.open[0].key + MAGIC).digest('base64');
    return Buffer.from(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`, 'utf8');
  }
  const settle = () => new Promise((r) => setTimeout(r, 25));
  return { socket, received, events, serverPush, pushToShim, handshake101, settle, id };
}

const hex = (buf) => Buffer.from(buf).toString('hex');

await test('open 消息:路径强制 skipWebSocketFrames=true,带 16 字节 key / version / debugLabel', async () => {
  const h = makeHarness();
  assert.equal(h.received.open.length, 1);
  const open = h.received.open[0];
  assert.equal(open.path, EXPECTED_PATH);
  assert.equal(open.version, '13');
  assert.equal(open.debugLabel, 'label-a');
  assert.equal(Buffer.from(open.key, 'base64').length, 16);
  assert.equal(typeof open.id, 'string');
  h.socket.close();
});

await test('101 → onOpen 恰好一次;accept 不对 → onError', async () => {
  const good = makeHarness();
  good.serverPush(good.handshake101());
  await good.settle();
  assert.equal(good.events.open, 1);
  assert.equal(good.events.error.length, 0);
  good.socket.close();

  const bad = makeHarness();
  bad.serverPush(bad.handshake101('bad'));
  await bad.settle();
  assert.equal(bad.events.open, 0);
  assert.equal(bad.events.error.length, 1);
  assert.match(bad.events.error[0], /Sec-WebSocket-Accept/);
});

await test('非 101 状态行 → onError(expected HTTP 101 but got 403)', async () => {
  const h = makeHarness();
  h.serverPush(Buffer.from('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n', 'utf8'));
  await h.settle();
  assert.equal(h.events.open, 0);
  assert.match(h.events.error[0], /expected HTTP 101 but got 403/);
});

await test('裸字节透传:与 101 同片的余量 + 后续非法 WS 帧序列都原样交付', async () => {
  const h = makeHarness();
  const keepalive = Buffer.from('09000000000000000000000000', 'hex'); // 服务端真实的协议 keepalive
  h.serverPush(Buffer.concat([h.handshake101(), keepalive]));
  await h.settle();
  assert.equal(h.events.open, 1);
  assert.equal(hex(Buffer.concat(h.events.data)), hex(keepalive), '101 之后的字节必须原样交付(同片余量不能丢)');

  h.serverPush(Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f]));
  await h.settle();
  assert.equal(hex(Buffer.concat(h.events.data)), '0900000000000000000000000000ff10807f');
  h.socket.close();
});

await test('出方向:send() 原样送出,不加帧头/掩码', async () => {
  const h = makeHarness();
  h.serverPush(h.handshake101());
  await h.settle();
  const payload = Buffer.from([0x01, 0x02, 0x03, 0xfe, 0xff]);
  h.socket.send(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
  await h.settle();
  assert.equal(h.received.frames.length, 1);
  assert.equal(hex(h.received.frames[0]), '010203feff');
  h.socket.close();
});

await test('大载荷 70 KiB 双向原样往返', async () => {
  const h = makeHarness();
  h.serverPush(h.handshake101());
  await h.settle();
  const big = Buffer.alloc(70 * 1024, 0x5a);
  h.socket.send(big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength));
  h.serverPush(big);
  await h.settle();
  assert.equal(h.received.frames[0].length, big.length);
  assert.ok(h.events.data[0].equals(big));
  h.socket.close();
});

await test('open 之前的 send 排队,open 后按序冲出', async () => {
  const h = makeHarness();
  h.socket.send(new Uint8Array([1]).buffer);
  h.socket.send(new Uint8Array([2]).buffer);
  await h.settle();
  assert.equal(h.received.frames.length, 0, '握手完成前不应发送');
  h.serverPush(h.handshake101());
  await h.settle();
  assert.deepEqual(h.received.frames.map((b) => b[0]), [1, 2]);
  h.socket.close();
});

await test('101 跨两个 chunk 到达也能识别', async () => {
  const h = makeHarness();
  const full = h.handshake101();
  h.serverPush(full.subarray(0, 20));
  await h.settle();
  assert.equal(h.events.open, 0);
  h.serverPush(full.subarray(20));
  await h.settle();
  assert.equal(h.events.open, 1);
  h.socket.close();
});

await test('close() 幂等;open 前 close 报 1006', async () => {
  const h = makeHarness();
  h.serverPush(h.handshake101());
  await h.settle();
  h.socket.close();
  h.socket.close();
  await h.settle();
  assert.equal(h.events.close.length, 1);
  assert.equal(h.events.close[0].code, 1000);
  assert.equal(h.received.close, 1);

  const early = makeHarness();
  early.socket.close();
  await early.settle();
  assert.equal(early.events.close.length, 1);
  assert.equal(early.events.close[0].code, 1006);
});

await test('父窗口 {kind:"error"} → onError;{kind:"closed"} → onClose(1006) 且只一次', async () => {
  const broken = makeHarness();
  broken.serverPush(broken.handshake101());
  await broken.settle();
  broken.pushToShim({ kind: 'error', message: 'tunnel broke' });
  await broken.settle();
  assert.equal(broken.events.error.length, 1);
  assert.match(broken.events.error[0], /tunnel broke/);
  assert.equal(broken.events.close.length, 1);
  assert.equal(broken.events.close[0].code, 1006);

  const closed = makeHarness();
  closed.serverPush(closed.handshake101());
  await closed.settle();
  closed.pushToShim({ kind: 'closed' });
  closed.pushToShim({ kind: 'closed' });
  await closed.settle();
  assert.equal(closed.events.close.length, 1);
  assert.equal(closed.events.close[0].reason, 'tunnel closed');
});

await test('握手响应超限 → onError(不会无限缓冲)', async () => {
  const h = makeHarness();
  h.serverPush(Buffer.alloc(70000, 0x41)); // 没有 \r\n\r\n
  await h.settle();
  assert.equal(h.events.open, 0);
  assert.match(h.events.error[0], /handshake response exceeds/);
});

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
