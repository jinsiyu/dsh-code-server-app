// scripts/test-pipe-tunnel.mjs —— lib/pipe-tunnel.mjs 的离线测试(不需要 DSH/IDE)
//
// 覆盖:token 拒绝、目标不可用 → 503、双向流式(响应先到、请求体后到)、取消、统计。
// 用法:node scripts/test-pipe-tunnel.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPipeTunnel, TUNNEL_TOKEN_HEADER } from '../lib/pipe-tunnel.mjs';

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    // 每个用例 10s 上限:死锁类回归必须以 FAIL 结束,而不是把整个套件挂住
    await Promise.race([
      fn(),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout 10s')), 10000)),
    ]);
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
}

const seen = { headers: null, chunks: [], firstResponseAt: null, doneAt: null };
const server = createServer(async (req, res) => {
  seen.headers = req.headers;
  seen.firstResponseAt = Date.now();
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  res.write(Buffer.from('SRV-FIRST\n'));
  for await (const chunk of req) {
    seen.chunks.push(chunk.toString('utf8'));
    res.write(Buffer.from(`ECHO:${chunk.toString('utf8')}`));
  }
  res.end('\nSRV-LAST');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const target = { current: { kind: 'loopback', port } };
const tunnel = createPipeTunnel({
  getTarget: () => target.current,
  token: 'T0KEN',
  log: () => {},
});

function streamBody(parts, gapMs) {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= parts.length) { controller.close(); return; }
      controller.enqueue(new TextEncoder().encode(parts[i++]));
      await new Promise((r) => setTimeout(r, gapMs));
    },
  });
}

function makeRequest(extraHeaders = {}, body) {
  return new Request('https://dsh.invalid/api/code-server/tunnel', {
    method: 'POST',
    ...(body === undefined ? {} : { body, duplex: 'half' }),
    headers: {
      [TUNNEL_TOKEN_HEADER]: 'T0KEN',
      'x-dshcs-ws-path': '/stable-abc?reconnectionToken=t&skipWebSocketFrames=false',
      'x-dshcs-ws-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'x-dshcs-ws-version': '13',
      ...extraHeaders,
    },
  });
}

await test('token 不匹配 → 403', async () => {
  const response = await tunnel.fetch(makeRequest({ [TUNNEL_TOKEN_HEADER]: 'wrong' }, 'x'));
  assert.equal(response.status, 403);
  assert.equal(tunnel.snapshot().rejected, 1);
});

await test('缺握手参数 → 400', async () => {
  const response = await tunnel.fetch(new Request('https://dsh.invalid/api/code-server/tunnel', {
    method: 'POST',
    body: 'x',
    duplex: 'half',
    headers: { [TUNNEL_TOKEN_HEADER]: 'T0KEN' },
  }));
  assert.equal(response.status, 400);
});

await test('IDE 未运行 → 503', async () => {
  target.current = null;
  const response = await tunnel.fetch(makeRequest({}, 'x'));
  assert.equal(response.status, 503);
  target.current = { kind: 'loopback', port };
});

await test('双向流式:响应先到,请求体逐片到,字节完整', async () => {
  const started = Date.now();
  const response = await tunnel.fetch(makeRequest({}, streamBody(['a', 'b', 'c'], 30)));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let firstAt = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstAt === null) firstAt = Date.now() - started;
    text += decoder.decode(value, { stream: true });
  }
  assert.match(text, /SRV-FIRST/);
  assert.match(text, /ECHO:a/);
  assert.match(text, /ECHO:b/);
  assert.match(text, /ECHO:c/);
  assert.match(text, /SRV-LAST/);
  assert.ok(firstAt !== null && firstAt < 60, `首个响应分片应在请求体写完前到达(firstAt=${firstAt}ms)`);
  assert.deepEqual(seen.chunks, ['a', 'b', 'c']);
  assert.equal(seen.headers['x-dshcs-ws-key'], 'dGhlIHNhbXBsZSBub25jZQ==');
  assert.match(String(seen.headers['x-dshcs-ws-path']), /^\/stable-abc\?/);
});

await test('请求体静默时 header 先发出去(防死锁回归)', async () => {
  // 真实场景:客户端要等 101 才发第一个字节,请求体一开始是静默的。
  // Node 的 ClientRequest 只在第一次 write/end 才发 header —— 不 flushHeaders 就是死锁。
  const silent = new ReadableStream({ start() { /* 永不产出,也永不关闭 */ } });
  const started = Date.now();
  const response = await tunnel.fetch(makeRequest({}, silent));
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  const elapsed = Date.now() - started;
  assert.ok(first.value !== undefined, '应立刻拿到服务端首片');
  assert.ok(elapsed < 2000, `应立即响应(实测 ${elapsed}ms)`);
  await reader.cancel();
});

await test('统计口径:opened/bytesIn/bytesOut 增长', async () => {
  const stats = tunnel.snapshot();
  assert.ok(stats.opened >= 1, 'opened 应大于 0');
  assert.ok(stats.bytesIn > 0, 'bytesIn 应大于 0');
  assert.ok(stats.bytesOut > 0, 'bytesOut 应大于 0');
  assert.equal(typeof stats.lastAt, 'number');
});

server.close();
console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
