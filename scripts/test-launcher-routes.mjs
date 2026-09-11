// scripts/test-launcher-routes.mjs —— launcher 的 HTTP 路由回归(必须容忍查询串)
//
// 背景(2026-09-11 实测的长期 bug):客户端加载文档时永远带查询串(`?s=<pid>&folder=…`),
// 而 launcher 原先用 `url === '/'` 判断要不要改写 HTML ⇒ 真实运行里 HTML 改写(注入诊断脚本 +
// 资源 `?v=` 缓存击穿)**从未生效**;本地探针用裸 `/` 所以一直没暴露。
//
// 断言:带查询串的文档请求必须拿到「注入过诊断脚本 + 资源带 ?v=」的 HTML;`/healthz`、`/_static/*`
// 这类按路径匹配的入口同样要容忍查询串。
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
const HOME = join(TMP, 'home');
mkdirSync(HOME, { recursive: true });
const PORT = 18390;
const TAG = 'testtag-1';

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
  '--port', String(PORT), '--exthost-ipc', `\\\\.\\pipe\\dshcs-routes-${process.pid}`,
  '--parent-pid', String(process.pid),
], {
  stdio: ['ignore', openSync(join(TMP, 'out.log'), 'a'), openSync(join(TMP, 'err.log'), 'a')],
  env: { ...process.env, DSH_HOME: HOME, DSHCS_HTML_TAG: TAG, DSHCS_TUNNEL_MODE: '1' },
});

const get = (path) => new Promise((resolve) => {
  const req = request({ host: '127.0.0.1', port: PORT, path, timeout: 15000 }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
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
const productPath = JSON.parse(health.body).productPath;

await test('文档请求带查询串时仍要改写 HTML(注入诊断脚本 + 资源 ?v=)', async () => {
  const res = await get('/?s=1234&folder=%2FC%3A%2Ftmp');
  assert.equal(res.status, 200, `状态应为 200(实际 ${res.status})`);
  assert.ok(res.body.includes(`workbench.js?v=${TAG}`), 'workbench.js 必须带 ?v= 缓存击穿');
  assert.ok(res.body.includes(`workbench.css?v=${TAG}`), 'workbench.css 必须带 ?v= 缓存击穿');
  assert.ok(res.body.includes("?d="), '注入的诊断脚本必须存在(信标通道)');
  assert.ok(res.body.includes('__DSH_WS_FACTORY__'), '诊断脚本必须报 shim 状态');
});

await test('裸路径文档同样改写(两种形态都要覆盖)', async () => {
  const res = await get('/');
  assert.ok(res.body.includes(`workbench.js?v=${TAG}`), '裸 / 也要带 ?v=');
});

await test('workbench.js 在隧道模式下注入 shim(带查询串也要命中)', async () => {
  const res = await get(`/${productPath}/static/out/vs/code/browser/workbench/workbench.js?v=${TAG}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('__DSHCS_PIPE_WS__'), 'bundle 里应含裸字节 shim 哨兵');
  assert.ok(res.body.includes('webSocketFactory:globalThis.__DSH_WS_FACTORY__}'), '应注入 webSocketFactory');
});

await test('/healthz 容忍查询串,并回报 htmlTag', async () => {
  const res = await get('/healthz?s=1');
  assert.equal(res.status, 200, `实际 ${res.status}`);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.htmlTag, TAG, 'healthz 应回报生效的 ?v= 标记,便于排查');
});

await test('/_static/* 容忍查询串(带 ?d= 的诊断信标就走这类路径)', async () => {
  const res = await get('/_static/src/browser/robots.txt?d=%7B%22kind%22%3A%22boot%22%7D');
  assert.equal(res.status, 200, `实际 ${res.status}`);
});

child.kill();
await new Promise((r) => setTimeout(r, 500));
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 句柄未释放 */ }
console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
