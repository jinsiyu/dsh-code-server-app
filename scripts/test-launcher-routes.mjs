// scripts/test-launcher-routes.mjs —— launcher 的 HTTP 路由 / HTML 改写 / **路径令牌与端口随机化**回归
//
// 守两类长期 bug:
//  B1 文档请求**永远带查询串**(`?s=<pid>&folder=<cwd>`),而路由用 `url === '/'` 判断 ⇒
//     HTML 改写(资源 `?v=` 缓存击穿)整条失效 ⇒ 升级后渲染器继续跑旧 bundle;
//     `/healthz`、`/manifest.json` 这类入口带查询串也会掉到 VS Code 变成 404。
//  B2(0.2.14)安全面:路径令牌必须挡住"没有令牌的请求";Host 白名单必须挡住非本机 Host;
//     端口 0 时实际端口必须经 endpoint 文件回报(host 靠它才知道去哪儿连)。
//
// 用法:node scripts/test-launcher-routes.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');

/** 挑一棵**能真跑**的树。
 *
 *  为什么不用仓库自己的 dev 树:`vendor/vscode/lib/vscode/node_modules` 里的 `@vscode/spdlog` 等
 *  原生依赖来自平台聚合包(可选依赖,只装在 profile 里)——仓库里没有它,`ensureRuntimeLayout()`
 *  既找不到也就建不出 junction,而 **ESM 不认 NODE_PATH**,于是 launcher 会在 import 树入口时就
 *  `ERR_MODULE_NOT_FOUND`(这是环境问题,不是 launcher 的问题)。
 *  所以:优先用已安装 profile 的树,并借**已安装插件自己的** lib/native.js 把 junction 建齐
 *  (它的 PACKAGE_ROOT 在 profile 里,才找得到聚合包);一个都不行才 SKIP。 */
async function pickTree() {
  for (const profile of ['desktop', 'web']) {
    const profileRoot = join(homedir(), '.dsh', 'profiles', profile, 'node_modules');
    const pluginDir = join(profileRoot, 'dsh-code-server-app');
    const tree = join(profileRoot, '@jinsiyu', 'dshcs-vscode-server', 'vscode');
    if (!existsSync(join(pluginDir, 'lib', 'native.js'))) continue;
    if (!existsSync(join(tree, 'lib', 'vscode', 'out', 'server-main.js'))) continue;
    try {
      const native = await import(pathToFileURL(join(pluginDir, 'lib', 'native.js')).href);
      native.ensureRuntimeLayout();
    } catch (error) {
      console.log(`     (${profile}: ensureRuntimeLayout 失败 ${error && error.message ? error.message : error})`);
      continue;
    }
    if (existsSync(join(tree, 'lib', 'vscode', 'node_modules', '@vscode', 'spdlog'))) {
      console.log(`     (使用 ${profile} profile 的树:${tree})`);
      return tree;
    }
  }
  return null;
}

const TREE = await pickTree();
if (TREE === null) {
  console.log('SKIP 找不到"内部依赖已建链接"的 VS Code 树;先在任一 profile 里启动一次 IDE 再跑本测试');
  process.exit(0);
}
const TMP = join(tmpdir(), `dshcs-routes-${process.pid}`);
mkdirSync(join(TMP, 'home'), { recursive: true });
const TAG = 'testtag-028';
const TOKEN = 'testtoken-0123456789abcdef';
const PREFIX = `/${TOKEN}`;
const TOKEN_FILE = join(TMP, 'path-token');
const ENDPOINT_FILE = join(TMP, 'endpoint.json');
writeFileSync(TOKEN_FILE, TOKEN, 'utf8');

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

// --port 0:由系统分配端口 —— launcher 必须把它写进 endpoint 文件(test 也顺带验这条链路)
const child = spawn(process.execPath, [
  join(PKG_ROOT, 'lib', 'launcher.mjs'), '--tree', TREE,
  '--user-data-dir', join(TMP, 'user-data'), '--extensions-dir', join(TMP, 'extensions'),
  '--port', '0', '--token-file', TOKEN_FILE, '--endpoint-file', ENDPOINT_FILE,
  '--parent-pid', String(process.pid),
], {
  stdio: ['ignore', openSync(join(TMP, 'out.log'), 'a'), openSync(join(TMP, 'err.log'), 'a')],
  env: { ...process.env, DSH_HOME: join(TMP, 'home'), DSHCS_HTML_TAG: TAG },
});

function readEndpoint() {
  try { return JSON.parse(readFileSync(ENDPOINT_FILE, 'utf8')); } catch { return null; }
}

let endpoint = null;
for (let i = 0; i < 120; i += 1) {
  endpoint = readEndpoint();
  if (endpoint !== null && Number.isInteger(endpoint.port) && endpoint.port > 0) break;
  endpoint = null;
  await new Promise((r) => setTimeout(r, 500));
}
if (endpoint === null) {
  console.error('launcher 未回报端点;out.log 尾部:');
  console.error(readFileSync(join(TMP, 'out.log'), 'utf8').split('\n').slice(-10).join('\n'));
  child.kill();
  process.exit(1);
}
const PORT = endpoint.port;

const get = (path, headers) => new Promise((resolve) => {
  const req = request({ host: '127.0.0.1', port: PORT, path, timeout: 15000, headers }, (res) => {
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
  health = await get(`${PREFIX}/healthz`);
  if (health.status === 200) break;
  await new Promise((r) => setTimeout(r, 500));
}
if (health.status !== 200) {
  console.error('launcher 未就绪;out.log 尾部:');
  console.error(readFileSync(join(TMP, 'out.log'), 'utf8').split('\n').slice(-10).join('\n'));
  child.kill();
  process.exit(1);
}

await test('端口 0 → endpoint 文件回报真实端口与 pid', async () => {
  assert.ok(Number.isInteger(endpoint.port) && endpoint.port > 0, `port 应为正整数(实际 ${endpoint.port})`);
  assert.equal(endpoint.pid, child.pid, 'endpoint.pid 应为 launcher 进程');
  assert.equal(endpoint.mode, 'tcp');
  assert.equal(endpoint.tokenized, true, '启用令牌时 endpoint 应标记 tokenized');
  assert.notEqual(endpoint.port, 0);
});

await test('没有令牌前缀的请求一律 404(不暴露"这里是 IDE")', async () => {
  for (const p of ['/', '/healthz', '/manifest.json', '/?s=1&folder=%2FC%3A%2Ftmp']) {
    const res = await get(p);
    assert.equal(res.status, 404, `${p} 应为 404(实际 ${res.status})`);
  }
});

await test('错误的令牌前缀同样 404', async () => {
  const res = await get('/wrongtoken-0123456789abcdef/healthz');
  assert.equal(res.status, 404, `实际 ${res.status}`);
});

await test('前缀少了结尾斜杠 → 302 补斜杠(相对引用才不会跑到根上)', async () => {
  const res = await get(PREFIX);
  assert.equal(res.status, 302, `实际 ${res.status}`);
  assert.equal(res.headers.location, `${PREFIX}/`);
});

await test('Host 白名单:非本机 Host → 403(挡 DNS rebinding)', async () => {
  const res = await get(`${PREFIX}/healthz`, { host: `evil.example:${PORT}` });
  assert.equal(res.status, 403, `实际 ${res.status}`);
  const ok = await get(`${PREFIX}/healthz`, { host: `localhost:${PORT}` });
  assert.equal(ok.status, 200, `localhost 应放行(实际 ${ok.status})`);
});

await test('文档请求带查询串时仍要改写 HTML(资源带 ?v= 缓存击穿)', async () => {
  const res = await get(`${PREFIX}/?s=1234&folder=%2FC%3A%2Ftmp`);
  assert.equal(res.status, 200, `状态应为 200(实际 ${res.status})`);
  assert.ok(res.body.includes(`workbench.js?v=${TAG}`), 'workbench.js 必须带 ?v= 缓存击穿');
  assert.ok(res.body.includes(`workbench.css?v=${TAG}`), 'workbench.css 必须带 ?v= 缓存击穿');
  assert.equal(res.headers['cache-control'], 'no-store', '改写后的 HTML 必须每次现取');
  assert.equal(res.headers['referrer-policy'], 'no-referrer', '文档响应必须禁 Referer(令牌在路径里)');
});

await test('裸路径文档同样改写(两种形态都要覆盖)', async () => {
  const res = await get(`${PREFIX}/`);
  assert.ok(res.body.includes(`workbench.js?v=${TAG}`), '裸 / 也要带 ?v=');
});

await test('/healthz 容忍查询串,并回报 htmlTag 与实际端口', async () => {
  const res = await get(`${PREFIX}/healthz?s=1`);
  assert.equal(res.status, 200, `实际 ${res.status}`);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.htmlTag, TAG);
  assert.equal(body.port, PORT, 'healthz 必须回报实际监听端口');
});

await test('/manifest.json 与 /_static/* 在前缀下仍可用', async () => {
  const man = await get(`${PREFIX}/manifest.json?v=1`);
  assert.equal(man.status, 200, `manifest 实际 ${man.status}`);
  assert.match(man.body, /"name"/);
  const st = await get(`${PREFIX}/_static/src/browser/robots.txt?v=1`);
  assert.equal(st.status, 200, `static 实际 ${st.status}`);
});

child.kill();
await new Promise((r) => setTimeout(r, 500));
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 句柄未释放 */ }
console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
