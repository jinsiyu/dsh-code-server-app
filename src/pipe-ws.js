/*
 * pipe-ws.js
 *
 * RFC6455 WebSocket client that runs on top of a postMessage byte tunnel.
 *
 * Why this exists: the VS Code browser workbench is embedded in an iframe and
 * cannot reach the DSH host. The embedding (parent) window owns the real
 * transport: it opens POST /api/code-server/tunnel, a streaming HTTP
 * request/response pair, and relays raw bytes between that tunnel and this
 * iframe. The workbench is configured with
 * IWorkbenchConstructionOptions.webSocketFactory, which expects an object of
 * the shape { create(url, debugLabel) { ... } } returning an IWebSocket.
 *
 * Wire protocol between this file and the parent window (all messages are
 * tagged with __dshcs: 1 and carry the socket id):
 *
 *   iframe -> parent   { kind: 'open',  id, path, key, version, debugLabel }
 *   iframe -> parent   { kind: 'frame', id, buf }        buf is an ArrayBuffer
 *   iframe -> parent   { kind: 'close', id }
 *   parent -> iframe   { kind: 'data',  id, buf }        raw bytes from tunnel
 *   parent -> iframe   { kind: 'error', id, message }
 *   parent -> iframe   { kind: 'closed', id }
 *
 * The tunnel delivers the raw HTTP 101 handshake response first and RFC6455
 * frames after it, so the client half of RFC6455 (handshake validation, frame
 * codec, masking, fragmentation, control frames) is implemented here.
 *
 * This file is ASCII only, has no imports/exports/requires, and is inlined at
 * the top of a minified browser bundle, therefore it is one self contained
 * IIFE that only publishes globalThis.__DSH_WS_FACTORY__.
 */
(function () {
  'use strict';

  var MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  var PROTOCOL_VERSION = '13';

  // Bound every buffer so a hostile or broken peer cannot exhaust memory.
  var MAX_HANDSHAKE_BYTES = 64 * 1024;
  var MAX_MESSAGE_BYTES = 512 * 1024 * 1024;
  var MAX_OUTBOUND_BYTES = 16 * 1024 * 1024;
  var MAX_TRACE_ENTRIES = 32;

  var BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  var OPCODE_CONTINUATION = 0x0;
  var OPCODE_TEXT = 0x1;
  var OPCODE_BINARY = 0x2;
  var OPCODE_CLOSE = 0x8;
  var OPCODE_PING = 0x9;
  var OPCODE_PONG = 0xa;

  var socketCounter = 0;
  var sharedEncoder = null;
  var sharedDecoder = null;

  // Small ring buffer, only maintained when globalThis.__DSH_WS_DEBUG__ is set.
  var traceRing = [];
  var traceCursor = 0;

  function tracingEnabled() {
    return !!globalThis.__DSH_WS_DEBUG__;
  }

  function traceSocketEvent(type, data) {
    if (!tracingEnabled()) return;
    var entry = { time: Date.now(), type: String(type) };
    if (data !== undefined) entry.data = data;
    traceRing[traceCursor % MAX_TRACE_ENTRIES] = entry;
    traceCursor++;
  }

  function traceDump() {
    var out = [];
    var count = Math.min(traceCursor, MAX_TRACE_ENTRIES);
    var start = traceCursor > MAX_TRACE_ENTRIES ? traceCursor % MAX_TRACE_ENTRIES : 0;
    for (var i = 0; i < count; i++) out.push(traceRing[(start + i) % MAX_TRACE_ENTRIES]);
    return out;
  }

  function utf8Encode(text) {
    if (!sharedEncoder) sharedEncoder = new TextEncoder();
    return sharedEncoder.encode(text);
  }

  function utf8Decode(bytes) {
    if (!sharedDecoder) sharedDecoder = new TextDecoder('utf-8');
    return sharedDecoder.decode(bytes);
  }

  function bytesToBase64(bytes) {
    var out = '';
    var i = 0;
    var n;
    for (; i + 3 <= bytes.length; i += 3) {
      n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += BASE64_CHARS.charAt((n >> 18) & 63)
        + BASE64_CHARS.charAt((n >> 12) & 63)
        + BASE64_CHARS.charAt((n >> 6) & 63)
        + BASE64_CHARS.charAt(n & 63);
    }
    var rest = bytes.length - i;
    if (rest === 1) {
      n = bytes[i] << 16;
      out += BASE64_CHARS.charAt((n >> 18) & 63) + BASE64_CHARS.charAt((n >> 12) & 63) + '==';
    } else if (rest === 2) {
      n = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += BASE64_CHARS.charAt((n >> 18) & 63)
        + BASE64_CHARS.charAt((n >> 12) & 63)
        + BASE64_CHARS.charAt((n >> 6) & 63)
        + '=';
    }
    return out;
  }

  function randomBytes(count) {
    var bytes = new Uint8Array(count);
    crypto.getRandomValues(bytes);
    return bytes;
  }

  // base64(sha1(key + MAGIC)) per RFC6455 section 4.2.2.
  function computeAccept(key) {
    var input = utf8Encode(key + MAGIC);
    return crypto.subtle.digest('SHA-1', input).then(function (digest) {
      return bytesToBase64(new Uint8Array(digest));
    });
  }

  function indexOfHeaderEnd(bytes) {
    for (var i = 0; i + 3 < bytes.length; i++) {
      if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
    }
    return -1;
  }

  // A tiny FIFO of Uint8Array chunks with byte oriented reads.
  function ByteQueue() {
    this.parts = [];
    this.offset = 0;
    this.size = 0;
  }

  ByteQueue.prototype.push = function (bytes) {
    if (!bytes || bytes.length === 0) return;
    this.parts.push(bytes);
    this.size += bytes.length;
  };

  // Returns a copy of the first count bytes (fewer when the queue is short).
  ByteQueue.prototype.peek = function (count) {
    var wanted = Math.min(count, this.size);
    var out = new Uint8Array(wanted);
    var written = 0;
    var index = 0;
    var offset = this.offset;
    while (written < wanted && index < this.parts.length) {
      var part = this.parts[index];
      var take = Math.min(part.length - offset, wanted - written);
      out.set(part.subarray(offset, offset + take), written);
      written += take;
      offset = 0;
      index++;
    }
    return out;
  };

  ByteQueue.prototype.consume = function (count) {
    var wanted = Math.min(count, this.size);
    if (this.parts.length === 1 && this.offset === 0 && wanted === this.parts[0].length) {
      var single = this.parts[0];
      this.parts = [];
      this.offset = 0;
      this.size = 0;
      return single;
    }
    var out = new Uint8Array(wanted);
    var written = 0;
    while (written < wanted) {
      var part = this.parts[0];
      var take = Math.min(part.length - this.offset, wanted - written);
      out.set(part.subarray(this.offset, this.offset + take), written);
      written += take;
      this.offset += take;
      if (this.offset === part.length) {
        this.parts.shift();
        this.offset = 0;
      }
    }
    this.size -= wanted;
    return out;
  };

  function toBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer);
    return null;
  }

  function copyBytes(bytes) {
    return bytes.slice();
  }

  function buildClosePayload(code, reason) {
    var reasonBytes = reason ? utf8Encode(reason) : new Uint8Array(0);
    var payload = new Uint8Array(2 + reasonBytes.length);
    payload[0] = (code >> 8) & 0xff;
    payload[1] = code & 0xff;
    payload.set(reasonBytes, 2);
    return payload;
  }

  // A close code we are allowed to echo back on the wire.
  function echoCloseCode(code) {
    if (typeof code !== 'number') return 1000;
    if (code < 1000 || code > 4999) return 1000;
    if (code === 1005 || code === 1006 || code === 1015) return 1000;
    return code;
  }

  // Minimal fallback for hosts without the WHATWG URL constructor. Kept tiny on
  // purpose: the bundle already runs in a modern browser, where URL exists.
  function fallbackPath(url) {
    var text = String(url);
    var schemeEnd = text.indexOf('://');
    var rest = schemeEnd >= 0 ? text.slice(schemeEnd + 3) : text;
    var slash = rest.indexOf('/');
    return slash >= 0 ? rest.slice(slash) : '/';
  }

  function createPipeWebSocket(url, debugLabel) {
    var path;
    if (typeof URL === 'function') {
      try {
        var parsed = new URL(url);
        path = parsed.pathname + parsed.search;
      } catch (err) {
        path = fallbackPath(url);
      }
    } else {
      path = fallbackPath(url);
    }

    // 16 random bytes, base64 encoded (RFC6455 section 4.1).
    var handshakeKey = bytesToBase64(randomBytes(16));
    var id = 'pws-' + (++socketCounter) + '-' + Math.random().toString(36).slice(2, 10);

    // 'handshake' until the 101 response validates, then 'open', then 'closed'.
    var state = 'handshake';
    var closeFired = false;
    var closeFrameSent = false;
    var pumping = false;
    var pumpRequested = false;

    var inbox = new ByteQueue();
    var pendingOutbound = [];
    var pendingOutboundBytes = 0;

    // Fragmented inbound message being assembled.
    var fragmentOpcode = 0;
    var fragmentChunks = null;
    var fragmentLength = 0;

    var listeners = { data: [], open: [], close: [], error: [] };

    function subscribe(name) {
      return function (listener) {
        if (typeof listener !== 'function') return { dispose: function () {} };
        var list = listeners[name];
        list.push(listener);
        var disposed = false;
        return {
          dispose: function () {
            if (disposed) return;
            disposed = true;
            var index = list.indexOf(listener);
            if (index >= 0) list.splice(index, 1);
          }
        };
      };
    }

    function emit(name, payload) {
      var list = listeners[name].slice();
      for (var i = 0; i < list.length; i++) list[i](payload);
    }

    function postToParent(message, transfer) {
      try {
        parent.postMessage(message, '*', transfer || []);
      } catch (err) {
        // Some hosts reject a transfer list; retry without it rather than lose
        // the frame.
        try {
          parent.postMessage(message, '*');
        } catch (err2) {
          traceSocketEvent('post-failed', String(err2 && err2.message ? err2.message : err2));
        }
      }
    }

    function postFrame(buffer) {
      postToParent({ __dshcs: 1, kind: 'frame', id: id, buf: buffer }, [buffer]);
    }

    function postClose() {
      postToParent({ __dshcs: 1, kind: 'close', id: id });
    }

    function detachListener() {
      try {
        window.removeEventListener('message', onMessage);
      } catch (err) {
        /* ignore */
      }
    }

    function fireClose(code, reason, wasClean, event) {
      if (closeFired) return;
      closeFired = true;
      state = 'closed';
      detachListener();
      traceSocketEvent('close', { code: code, reason: reason, wasClean: wasClean });
      emit('close', { code: code, reason: reason, wasClean: wasClean, event: event });
    }

    function fail(error) {
      if (state === 'closed') return;
      var err = error instanceof Error ? error : new Error(String(error));
      traceSocketEvent('error', err.message);
      emit('error', err);
      if (state === 'closed') return; // a listener may have called close()
      fireClose(1006, err.message, false, undefined);
      postClose();
    }

    // Mask and emit one outbound frame. The shim never fragments outbound data.
    function writeFrame(opcode, payload) {
      if (state === 'closed') return;
      var body = payload || new Uint8Array(0);
      var length = body.length;
      var headerLength = 2;
      var mode = 0;
      if (length >= 126 && length <= 0xffff) {
        headerLength = 4;
        mode = 2;
      } else if (length > 0xffff) {
        headerLength = 10;
        mode = 8;
      }
      var frame = new Uint8Array(headerLength + 4 + length);
      frame[0] = 0x80 | opcode; // FIN is always set for client frames here.
      var pos = 2;
      if (mode === 2) {
        frame[1] = 0x80 | 126;
        frame[2] = (length >>> 8) & 0xff;
        frame[3] = length & 0xff;
        pos = 4;
      } else if (mode === 8) {
        frame[1] = 0x80 | 127;
        var high = Math.floor(length / 4294967296);
        var low = length >>> 0;
        frame[2] = (high >>> 24) & 0xff;
        frame[3] = (high >>> 16) & 0xff;
        frame[4] = (high >>> 8) & 0xff;
        frame[5] = high & 0xff;
        frame[6] = (low >>> 24) & 0xff;
        frame[7] = (low >>> 16) & 0xff;
        frame[8] = (low >>> 8) & 0xff;
        frame[9] = low & 0xff;
        pos = 10;
      } else {
        frame[1] = 0x80 | length;
      }
      var maskKey = randomBytes(4);
      frame[pos] = maskKey[0];
      frame[pos + 1] = maskKey[1];
      frame[pos + 2] = maskKey[2];
      frame[pos + 3] = maskKey[3];
      var start = pos + 4;
      for (var i = 0; i < length; i++) frame[start + i] = body[i] ^ maskKey[i & 3];
      postFrame(frame.buffer);
    }

    function sendCloseFrame(code) {
      if (closeFrameSent) return;
      closeFrameSent = true;
      writeFrame(OPCODE_CLOSE, buildClosePayload(code, ''));
    }

    function flushOutbound() {
      var queued = pendingOutbound;
      pendingOutbound = [];
      pendingOutboundBytes = 0;
      for (var i = 0; i < queued.length; i++) writeFrame(OPCODE_BINARY, queued[i]);
    }

    function deliverMessage(bytes) {
      if (state === 'closed') return;
      traceSocketEvent('data', bytes.length);
      emit('data', bytes.buffer);
    }

    function appendFragment(bytes) {
      fragmentLength += bytes.length;
      if (fragmentLength > MAX_MESSAGE_BYTES) {
        throw new Error('pipe socket: assembled message exceeds ' + MAX_MESSAGE_BYTES + ' bytes');
      }
      fragmentChunks.push(copyBytes(bytes));
    }

    function assembledFragments() {
      var total = new Uint8Array(fragmentLength);
      var offset = 0;
      for (var i = 0; i < fragmentChunks.length; i++) {
        total.set(fragmentChunks[i], offset);
        offset += fragmentChunks[i].length;
      }
      return total;
    }

    function handleCloseFrame(payload) {
      var code = 1005; // "no status code present"
      var reason = '';
      if (payload.length >= 2) {
        code = (payload[0] << 8) | payload[1];
        if (payload.length > 2) reason = utf8Decode(payload.subarray(2));
      }
      // RFC6455 order: echo the close frame, report the remote code, then ask
      // the parent to drop the tunnel. Notifying the parent first would let a
      // parent that immediately reports kind:'closed' preempt the real code.
      sendCloseFrame(echoCloseCode(code));
      fireClose(code, reason, true, { code: code, reason: reason, wasClean: true });
      postClose();
    }

    function handleFrame(fin, opcode, payload) {
      if (opcode === OPCODE_PING) {
        traceSocketEvent('ping', payload.length);
        writeFrame(OPCODE_PONG, copyBytes(payload));
        return;
      }
      if (opcode === OPCODE_PONG) {
        traceSocketEvent('pong', payload.length);
        return;
      }
      if (opcode === OPCODE_CLOSE) {
        handleCloseFrame(payload);
        return;
      }
      if (opcode === OPCODE_CONTINUATION) {
        if (!fragmentChunks) throw new Error('pipe socket: unexpected continuation frame');
        appendFragment(payload);
        if (!fin) return;
        var messageOpcode = fragmentOpcode;
        var assembled = assembledFragments();
        fragmentChunks = null;
        fragmentLength = 0;
        fragmentOpcode = 0;
        traceSocketEvent('message', { opcode: messageOpcode, length: assembled.length });
        deliverMessage(assembled);
        return;
      }
      if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
        if (fragmentChunks) throw new Error('pipe socket: data frame inside a fragmented message');
        if (fin) {
          traceSocketEvent('message', { opcode: opcode, length: payload.length });
          deliverMessage(copyBytes(payload));
          return;
        }
        fragmentOpcode = opcode;
        fragmentChunks = [];
        fragmentLength = 0;
        appendFragment(payload);
        return;
      }
      throw new Error('pipe socket: unsupported opcode 0x' + opcode.toString(16));
    }

    // Consume every complete frame currently buffered. Returns true when at
    // least one frame was consumed (which may need another pass).
    function parseFrames() {
      var progressed = false;
      while (state === 'open') {
        var head = inbox.peek(14);
        if (head.length < 2) return progressed;
        var b0 = head[0];
        var b1 = head[1];
        var fin = (b0 & 0x80) !== 0;
        var rsv = b0 & 0x70;
        var opcode = b0 & 0x0f;
        if (rsv !== 0) throw new Error('pipe socket: reserved bits set in frame header');
        var masked = (b1 & 0x80) !== 0;
        if (masked) throw new Error('pipe socket: server frames must not be masked');
        var length = b1 & 0x7f;
        var headerLength = 2;
        if (length === 126) {
          if (head.length < 4) return progressed;
          length = (head[2] << 8) | head[3];
          headerLength = 4;
        } else if (length === 127) {
          if (head.length < 10) return progressed;
          var high = ((head[2] << 24) | (head[3] << 16) | (head[4] << 8) | head[5]) >>> 0;
          var low = ((head[6] << 24) | (head[7] << 16) | (head[8] << 8) | head[9]) >>> 0;
          length = high * 4294967296 + low;
          headerLength = 10;
        }
        var isControl = opcode >= 0x8;
        if (isControl && (!fin || length > 125)) {
          throw new Error('pipe socket: invalid control frame');
        }
        if (length > MAX_MESSAGE_BYTES) {
          throw new Error('pipe socket: frame payload exceeds ' + MAX_MESSAGE_BYTES + ' bytes');
        }
        if (inbox.size < headerLength + length) return progressed;
        var raw = inbox.consume(headerLength + length);
        progressed = true;
        handleFrame(fin, opcode, raw.subarray(headerLength));
      }
      return progressed;
    }

    function finishHandshake(headerText) {
      var lines = headerText.split('\r\n');
      var statusLine = (lines.shift() || '').trim();
      var match = /^HTTP\/1\.[01] ([0-9]{3})/.exec(statusLine);
      if (!match) throw new Error('pipe socket: malformed handshake status line');
      var statusCode = parseInt(match[1], 10);
      if (statusCode !== 101) {
        throw new Error('pipe socket: expected HTTP 101 but got ' + statusCode);
      }
      var headers = {};
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line) continue;
        var colon = line.indexOf(':');
        if (colon < 0) continue;
        var name = line.slice(0, colon).trim().toLowerCase();
        var value = line.slice(colon + 1).trim();
        headers[name] = headers[name] ? headers[name] + ', ' + value : value;
      }
      var upgrade = headers['upgrade'];
      if (upgrade && upgrade.toLowerCase() !== 'websocket') {
        throw new Error('pipe socket: unexpected Upgrade header');
      }
      var connection = headers['connection'];
      if (connection && connection.toLowerCase().indexOf('upgrade') < 0) {
        throw new Error('pipe socket: unexpected Connection header');
      }
      return computeAccept(handshakeKey).then(function (expected) {
        var actual = headers['sec-websocket-accept'];
        if (!actual || actual.trim() !== expected) {
          throw new Error('pipe socket: bad Sec-WebSocket-Accept header');
        }
        // close() may have run while the digest was pending.
        if (state !== 'handshake') return;
        state = 'open';
        traceSocketEvent('open', debugLabel);
        flushOutbound();
        emit('open', undefined);
      });
    }

    function pumpLoop() {
      var chain = Promise.resolve();
      var step = function () {
        if (state === 'closed') return null;
        if (state === 'handshake') {
          var head = inbox.peek(MAX_HANDSHAKE_BYTES + 4);
          var end = indexOfHeaderEnd(head);
          if (end < 0) {
            if (inbox.size > MAX_HANDSHAKE_BYTES) {
              throw new Error('pipe socket: handshake response exceeds ' + MAX_HANDSHAKE_BYTES + ' bytes');
            }
            return null;
          }
          if (end + 4 > MAX_HANDSHAKE_BYTES) {
            throw new Error('pipe socket: handshake response exceeds ' + MAX_HANDSHAKE_BYTES + ' bytes');
          }
          var headerBytes = inbox.consume(end + 4);
          return finishHandshake(utf8Decode(headerBytes)).then(step);
        }
        if (state === 'open') {
          if (parseFrames()) return Promise.resolve().then(step);
          return null;
        }
        return null;
      };
      return chain.then(step);
    }

    function pump() {
      if (state === 'closed') return;
      if (pumping) {
        pumpRequested = true;
        return;
      }
      pumping = true;
      pumpLoop().then(function () {
        pumping = false;
        if (pumpRequested) {
          pumpRequested = false;
          pump();
        }
      }, function (err) {
        pumping = false;
        pumpRequested = false;
        fail(err);
      });
    }

    function onMessage(event) {
      var data = event && event.data;
      if (!data || data.__dshcs !== 1 || data.id !== id) return;
      if (state === 'closed') return;
      if (data.kind === 'data') {
        var bytes = toBytes(data.buf);
        if (!bytes || bytes.length === 0) return;
        inbox.push(bytes);
        pump();
        return;
      }
      if (data.kind === 'error') {
        fail(new Error(data.message === undefined ? 'tunnel error' : String(data.message)));
        return;
      }
      if (data.kind === 'closed') {
        if (closeFired) return;
        traceSocketEvent('tunnel-closed');
        fireClose(1006, 'tunnel closed', false, undefined);
      }
    }

    function send(data) {
      if (state === 'closed') return;
      var bytes = toBytes(data);
      if (!bytes) return;
      if (state === 'open') {
        writeFrame(OPCODE_BINARY, bytes);
        return;
      }
      var copy = copyBytes(bytes);
      if (pendingOutboundBytes + copy.length > MAX_OUTBOUND_BYTES) {
        fail(new Error('pipe socket: outbound buffer exceeds ' + MAX_OUTBOUND_BYTES + ' bytes'));
        return;
      }
      pendingOutboundBytes += copy.length;
      pendingOutbound.push(copy);
    }

    function close() {
      if (state === 'closed') return;
      if (state === 'open') {
        sendCloseFrame(1000);
        fireClose(1000, '', true, { code: 1000, reason: '', wasClean: true });
        postClose();
        return;
      }
      // close() before the handshake finished: nothing left to negotiate.
      fireClose(1006, 'closed before open', false, undefined);
      postClose();
    }

    window.addEventListener('message', onMessage);
    postToParent({
      __dshcs: 1,
      kind: 'open',
      id: id,
      path: path,
      key: handshakeKey,
      version: PROTOCOL_VERSION,
      debugLabel: debugLabel
    });

    return {
      onData: subscribe('data'),
      onOpen: subscribe('open'),
      onClose: subscribe('close'),
      onError: subscribe('error'),
      traceSocketEvent: traceSocketEvent,
      send: send,
      close: close
    };
  }

  globalThis.__DSH_WS_FACTORY__ = {
    create: createPipeWebSocket,
    traceDump: traceDump
  };
})();
