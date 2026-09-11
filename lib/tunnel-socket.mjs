/**
 * lib/tunnel-socket.mjs —— 隧道用的合成 socket(把 HTTP 请求体/响应体当成 WebSocket 的字节流)。
 *
 * 为什么要有独立文件:这段代码的正确性直接决定隧道能不能握手成功,必须是可测的
 * (scripts/test-tunnel-socket.mjs)。踩过的坑:Duplex 的可写侧只有在**回调被调用**之后
 * 才会 drain,所以在 _write 里等 'drain' 是自我死锁 —— 必须等**下游**(HTTP 响应)的 drain。
 */
import { Duplex } from 'node:stream';

/**
 * @param {(chunk: Buffer, done: (error?: Error) => void) => void} writeToClient
 *   把字节写向客户端;背压时必须在 drain 后调用 done。
 */
export class TunnelSocket extends Duplex {
  constructor(writeToClient) {
    super({ allowHalfOpen: true });
    this.writeToClient = writeToClient;
  }

  _read() { /* 由 feed() 主动 push */ }

  _write(chunk, _encoding, callback) {
    try {
      this.writeToClient(chunk, callback);
    } catch (error) {
      callback(error);
    }
  }

  _final(callback) { callback(); }

  _destroy(error, callback) { callback(error); }

  /** 把客户端来的字节推进可读侧。 */
  feed(chunk) { this.push(chunk); }

  endFromClient() { this.push(null); }

  setTimeout() { return this; }

  setNoDelay() { return this; }

  setKeepAlive() { return this; }

  ref() { return this; }

  unref() { return this; }

  address() { return { address: '127.0.0.1', family: 'IPv4', port: 0 }; }
}

export default TunnelSocket;
