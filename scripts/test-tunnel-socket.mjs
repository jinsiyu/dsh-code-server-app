// scripts/test-tunnel-socket.mjs —— TunnelSocket 的背压语义测试(不需要 DSH/IDE)
//
// 回归点:_write 必须等**下游(HTTP 响应)的 drain**,而不是等 Duplex 自己的 drain
// (后者只有在回调被调用后才会发生 = 自我死锁)。线上症状:101 能发出去(第一次 write
// 未触发背压),之后服务端的协议握手回复永远发不出 → 客户端 10s 超时重连 → 白屏。
import assert from 'node:assert/strict';
import { TunnelSocket } from '../lib/tunnel-socket.mjs';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
}
async function testAsync(name, fn) {
  try {
    await Promise.race([fn(), new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout 5s')), 5000))]);
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
}

test('socket 具备 ws 需要的 net.Socket 表面', () => {
  const socket = new TunnelSocket((_c, done) => done());
  for (const method of ['setTimeout', 'setNoDelay', 'setKeepAlive', 'ref', 'unref', 'address', 'destroy', 'write', 'end']) {
    assert.equal(typeof socket[method], 'function', `${method} 必须存在`);
  }
  assert.equal(socket.address().address, '127.0.0.1');
  socket.destroy();
});

test('feed() 的数据能从可读侧读出', async () => {
  const socket = new TunnelSocket((_c, done) => done());
  const chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk.toString('utf8')));
  socket.feed(Buffer.from('hello'));
  socket.feed(Buffer.from('-world'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(chunks, ['hello', '-world']);
  socket.destroy();
});

await testAsync('背压:下游返回 false 时,等下游 drain 再回调(不是等自己)', async () => {
  const written = [];
  let drainListener = null;
  // 模拟 HTTP 响应:第一次 write 返回 false(触发背压),之后在 drain 时放行
  const socket = new TunnelSocket((chunk, done) => {
    written.push(chunk.toString('utf8'));
    if (written.length === 1) {
      drainListener = done; // 模拟 res.write() === false → 等 drain
    } else {
      done();
    }
  });
  socket.write(Buffer.from('101'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(written, ['101'], '第一片应已交给下游');
  // 此时写第二片:必须排队等第一片的回调(下行 drain),而不是立刻发出
  socket.write(Buffer.from('handshake-reply'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(written, ['101'], '背压期间第二片不应越过队列');
  assert.equal(typeof drainListener, 'function', '应把回调交给下游等待 drain');
  drainListener(); // 下游 drain
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(written, ['101', 'handshake-reply'], 'drain 之后第二片必须发出');
  socket.destroy();
});

await testAsync('下行一直不 drain 时不会自我死锁(等待期间可被 destroy)', async () => {
  let pending = null;
  const socket = new TunnelSocket((_chunk, done) => { pending = done; });
  socket.write(Buffer.from('x'));
  await new Promise((r) => setImmediate(r));
  assert.equal(typeof pending, 'function');
  socket.destroy();
  await new Promise((r) => setImmediate(r));
  assert.equal(socket.destroyed, true, 'destroy 应生效(没有被自身 drain 卡住)');
});

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
