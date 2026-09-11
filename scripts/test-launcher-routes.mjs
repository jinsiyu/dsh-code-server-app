// scripts/test-launcher-routes.mjs —— launcher 的 HTTP 路由/HTML 改写回归(0.2.8)
//
// 两个长期 bug 的守门测试(均于 2026-09-11 在 0.3.x 线上定位,同样影响 0.2.x):
//  B1 文档请求**永远带查询串**(`?s=<pid>&folder=<cwd>`),而路由用 `url === '/'` 判断 ⇒
//     HTML 改写(资源 `?v=` 缓存击穿)整条失效 ⇒ 升级后渲染器继续跑旧 bundle;
//     `/healthz`、`/manifest.json` 这类入口带查询串也会掉到 VS Code 变成 404。
//
// 用法:node scripts/test-launcher-routes.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');
const TREE = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@jinsiyu', 'dshcs-vscode-server', 'vscode');
if (!existsSync(TREE)) {
  console.log(`SKIP 找不到 VS Code 树(${TREE})`);
  process.exit(0);
}
const TMP = join(tmpdir(), `dshcs-routes-${process.pid}`);
mkdirSync(join(TMP, 'home'), { recursive: true });
const PORT = 18396;
const TAG = 'testtag-028';

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
}

const child = spawn(process.execPath, [
  join(PKG_ROOT, 'lib', 'launcher.mjs'), '--tree', TREE,
  '--user-data-dir', join(TMP, 'user-data'), '--extensions-dir', join(TMP, 'extensions'),
  '--port', String(PORT), '--parent-pid', String(process.pid),
], {
  stdio: ['ignore', openSync(join(TMP, 'out.log'), 'a'), openSync(join(TMP, 'err.log'), 'a')],
  env: { ...process.env, DSH_HOME: join(TMP, 'home'), DSHCS_HTML_TAG: TAG },
});

const get = (path) => new Promise((resolve) => {
  const req = request({ host: '127.0.0.1', port: PORT, path, timeout: 15000 }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
  req.end();
});

let health = { status: 0, body: '' };
for (let i = 0; i < 120; i += 1) {
  health = await get('/healthz');
  if (health.status === 200) break;
  await new Promise((r) => setTimeout(r, 500));
}
if (health.status !== 200) {
  console.error('launcher 未就绪;out.log 尾部:');
  console.error(readFileSync(join(TMP, 'out.log'), 'utf8').split('\n').slice(-10).join('\n'));
  child.kill();
  process.exit(1);
}

await test('文档请求带查询串时仍要改写 HTML(资源带 ?v= 缓存击穿)', async () => {
  const res = await get('/?s=1234&folder=%2FC%3A%2Ftmp');
  assert.equal(res.status, 200, `状态应为 200(实际 ${res.status})`);
  assert.ok(res.body.includes(`workbench.js?v=${TAG}`), 'workbench.js 必须带 ?v= 缓存击穿');
  assert.ok(res.body.includes(`workbench.css?v=${TAG}`), 'workbench.css 必须带 ?v= 缓存击穿');
  assert.equal(res.headers['cache-control'], 'no-store', '改写后的 HTML 必须每次现取');
});

await test('裸路径文档同样改写(两种形态都要覆盖)', async () => {
  const res = await get('/');
  assert.ok(res.body.includes(`workbench.js?v=${TAG}`), '裸 / 也要带 ?v=');
});

await test('/healthz 容忍查询串,并回报 htmlTag', async () => {
  const res = await get('/healthz?s=1');
  assert.equal(res.status, 200, `实际 ${res.status}`);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.htmlTag, TAG);
});

await test('/manifest.json 容忍查询串', async () => {
  const res = await get('/manifest.json?v=1');
  assert.equal(res.status, 200, `实际 ${res.status}`);
  assert.match(res.body, /"name"/);
});

await test('/_static/* 容忍查询串', async () => {
  const res = await get('/_static/src/browser/robots.txt?v=1');
  assert.equal(res.status, 200, `实际 ${res.status}`);
});

child.kill();
await new Promise((r) => setTimeout(r, 500));
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 句柄未释放 */ }
console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
