/*
 * pipe-ws.js - the client half of the IDE byte tunnel, exposed through VS Code's
 * official IWorkbenchConstructionOptions.webSocketFactory seam.
 *
 * It is NOT a WebSocket implementation. The tunnel terminates at a server that was told
 * skipWebSocketFrames=true, which makes it treat the socket as a plain byte stream (this is
 * the same shape as Electron's MessagePort transport): after the HTTP 101 handshake it
 * writes VS Code protocol messages with no RFC6455 framing. Verified against the real
 * server: the first post-handshake bytes are `09 00 00 ...`, a protocol keepalive header,
 * which is not a valid frame sequence.
 *
 * So this file does exactly three things:
 *   1. asks the parent window to open a tunnel (path + handshake key + protocol version);
 *   2. consumes the HTTP 101 response (and validates Sec-WebSocket-Accept), then fires onOpen;
 *   3. from then on passes bytes through untouched in both directions.
 *
 * Everything else (framing, masking, fragmentation) would be dead weight.
 *
 * Parent protocol (window.parent <-> this iframe):
 *   out  { __dshcs:1, kind:'open',  id, path, key, version, debugLabel }
 *        { __dshcs:1, kind:'frame', id, buf:ArrayBuffer }
 *        { __dshcs:1, kind:'close', id }
 *   in   { __dshcs:1, kind:'data',  id, buf:ArrayBuffer }
 *        { __dshcs:1, kind:'error', id, message }
 *        { __dshcs:1, kind:'closed',id }
 */
(function () {
  'use strict';

  var PROTOCOL_VERSION = '13';
  var MAX_HANDSHAKE_BYTES = 65536;
  var MAX_PENDING_BYTES = 16 * 1024 * 1024;
  var socketCounter = 0;

  function utf8Encode(text) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text);
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    return new Uint8Array(out);
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(bytes);
    var text = '';
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return text;
  }

  function bytesToBase64(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function randomKey() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return bytesToBase64(bytes);
  }

  /** RFC6455 section 4.2.2: base64(sha1(key + GUID)). */
  function computeAccept(key) {
    var input = utf8Encode(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
    return crypto.subtle.digest('SHA-1', input).then(function (digest) {
      return bytesToBase64(new Uint8Array(digest));
    });
  }

  function indexOfHeaderEnd(bytes) {
    for (var i = 3; i < bytes.length; i++) {
      if (bytes[i] === 10 && bytes[i - 1] === 13 && bytes[i - 2] === 10 && bytes[i - 3] === 13) return i - 3;
    }
    return -1;
  }

  function concat(chunks, total) {
    if (chunks.length === 1) return chunks[0];
    var out = new Uint8Array(total);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], offset); offset += chunks[i].length; }
    return out;
  }

  function toBytes(data) {
    if (data === undefined || data === null) return null;
    if (typeof data === 'string') return utf8Encode(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }

  function copyOut(bytes) {
    var out = new Uint8Array(bytes.length);
    out.set(bytes);
    return out.buffer;
  }

  function fallbackPath(url) {
    var text = String(url);
    var schemeEnd = text.indexOf('://');
    var rest = schemeEnd >= 0 ? text.slice(schemeEnd + 3) : text;
    var slash = rest.indexOf('/');
    return slash >= 0 ? rest.slice(slash) : '/';
  }

  // The tunnel's server side is told skipWebSocketFrames=true because this client is a raw
  // byte pipe; the browser client's value (false) would make the server add its own frame
  // layer, which a raw client cannot parse (symptom: connection dies, endless reconnects).
  function forceSkipFrames(path) {
    if (/[?&]skipWebSocketFrames=/.test(path)) {
      return path.replace(/skipWebSocketFrames=(?:true|false)/, 'skipWebSocketFrames=true');
    }
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'skipWebSocketFrames=true';
  }

  function createPipeWebSocket(url, debugLabel) {
    var path = typeof URL === 'function' ? (function () {
      try {
        var parsed = new URL(url);
        return parsed.pathname + parsed.search;
      } catch (err) {
        return fallbackPath(url);
      }
    })() : fallbackPath(url);
    path = forceSkipFrames(path);

    var id = 'pws-' + (++socketCounter) + '-' + Math.random().toString(36).slice(2, 10);
    var handshakeKey = randomKey();
    var state = 'handshake';
    var closeFired = false;
    var pending = [];
    var pendingBytes = 0;

    /** Head-of-line bytes not yet consumed (handshake, then raw protocol data). */
    var inbox = [];
    var inboxBytes = 0;

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
          },
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
        try {
          parent.postMessage(message, '*');
        } catch (err2) {
          /* nothing else to do */
        }
      }
    }

    function postFrame(bytes) {
      var buffer = copyOut(bytes);
      postToParent({ __dshcs: 1, kind: 'frame', id: id, buf: buffer }, [buffer]);
    }

    function postClose() {
      postToParent({ __dshcs: 1, kind: 'close', id: id });
    }

    function detachListener() {
      try { window.removeEventListener('message', onMessage); } catch (err) { /* ignore */ }
    }

    function fireClose(code, reason, wasClean, event) {
      if (closeFired) return;
      closeFired = true;
      state = 'closed';
      detachListener();
      emit('close', { code: code, reason: reason, wasClean: wasClean, event: event });
    }

    function fail(error) {
      if (state === 'closed') return;
      var err = error instanceof Error ? error : new Error(String(error));
      emit('error', err);
      if (state === 'closed') return;
      fireClose(1006, err.message, false, undefined);
      postClose();
    }

    function deliver(bytes) {
      if (state === 'closed' || bytes.length === 0) return;
      emit('data', copyOut(bytes));
    }

    function flushPending() {
      var queued = pending;
      pending = [];
      pendingBytes = 0;
      for (var i = 0; i < queued.length; i++) postFrame(queued[i]);
    }

    function takeInbox() {
      var all = concat(inbox, inboxBytes);
      inbox = [];
      inboxBytes = 0;
      return all;
    }

    function parseHandshakeAndOpen(head) {
      var end = indexOfHeaderEnd(head);
      if (end < 0) {
        if (head.length > MAX_HANDSHAKE_BYTES) {
          fail(new Error('pipe socket: handshake response exceeds ' + MAX_HANDSHAKE_BYTES + ' bytes'));
          return;
        }
        inbox = [head];
        inboxBytes = head.length;
        return;
      }
      var headerText = utf8Decode(head.subarray(0, end));
      var rest = head.subarray(end + 4);
      var lines = headerText.split('\r\n');
      var statusLine = (lines.shift() || '').trim();
      var match = /^HTTP\/1\.[01] ([0-9]{3})/.exec(statusLine);
      if (!match) { fail(new Error('pipe socket: malformed handshake status line')); return; }
      if (parseInt(match[1], 10) !== 101) {
        fail(new Error('pipe socket: expected HTTP 101 but got ' + match[1]));
        return;
      }
      var headers = {};
      for (var i = 0; i < lines.length; i++) {
        var colon = lines[i].indexOf(':');
        if (colon < 0) continue;
        headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim();
      }
      computeAccept(handshakeKey).then(function (expected) {
        var actual = headers['sec-websocket-accept'];
        if (!actual || actual !== expected) throw new Error('pipe socket: bad Sec-WebSocket-Accept header');
        if (state !== 'handshake') return;
        state = 'open';
        flushPending();
        emit('open', undefined);
        // Raw protocol bytes may have arrived in the same chunk as the 101.
        deliver(rest);
        pump();
      }, fail).catch(fail);
    }

    function pump() {
      if (state === 'closed' || inboxBytes === 0) return;
      if (state === 'handshake') {
        parseHandshakeAndOpen(takeInbox());
        return;
      }
      deliver(takeInbox());
    }

    function send(data) {
      if (state === 'closed') return;
      var bytes = toBytes(data);
      if (bytes === null || bytes.length === 0) return;
      if (state === 'open') { postFrame(bytes); return; }
      if (pendingBytes + bytes.length > MAX_PENDING_BYTES) {
        fail(new Error('pipe socket: pending outbound bytes exceed ' + MAX_PENDING_BYTES));
        return;
      }
      pending.push(bytes);
      pendingBytes += bytes.length;
    }

    function close() {
      if (state === 'closed') return;
      var wasOpen = state === 'open';
      fireClose(wasOpen ? 1000 : 1006, wasOpen ? '' : 'closed before open', wasOpen, wasOpen ? { code: 1000, reason: '', wasClean: true } : undefined);
      postClose();
    }

    function onMessage(event) {
      var data = event && event.data;
      if (data === null || typeof data !== 'object' || data.__dshcs !== 1 || data.id !== id) return;
      if (data.kind === 'data') {
        var bytes = data.buf === undefined || data.buf === null ? null : new Uint8Array(data.buf);
        if (bytes === null || bytes.length === 0) return;
        inbox.push(bytes);
        inboxBytes += bytes.length;
        pump();
        return;
      }
      if (data.kind === 'error') {
        fail(new Error(data.message === undefined ? 'tunnel error' : String(data.message)));
        return;
      }
      if (data.kind === 'closed') {
        if (closeFired) return;
        fireClose(1006, 'tunnel closed', false, undefined);
      }
    }

    window.addEventListener('message', onMessage);
    postToParent({
      __dshcs: 1,
      kind: 'open',
      id: id,
      path: path,
      key: handshakeKey,
      version: PROTOCOL_VERSION,
      debugLabel: debugLabel,
    });

    return {
      onData: subscribe('data'),
      onOpen: subscribe('open'),
      onClose: subscribe('close'),
      onError: subscribe('error'),
      traceSocketEvent: function () {},
      send: send,
      close: close,
    };
  }

  globalThis.__DSH_WS_FACTORY__ = { create: createPipeWebSocket };
})();
