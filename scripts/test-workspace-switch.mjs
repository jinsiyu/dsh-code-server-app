// scripts/test-workspace-switch.mjs —— 切工作区必须是"轻量切换"(0.2.12)
//
// 断言的不变量:
//   POST /api/code-server/start {cwd: B} 打到**已运行**的实例上时,
//   ① 返回的 snapshot.cwd 变成 B、status 仍 running;
//   ② **pid 不变**(没有 stop + 重新 launch);
//   ③ 原进程**还活着**(旧行为会 killTree 掉它)。
//
// 怎么做:host 的 adopt 路径(端口已被占用 + pid.json 有效)可以完全在测试里复现 ——
// 起一个只回 200 的本地 HTTP 服务当 /healthz,再 spawn 一个长活子进程当"IDE 进程",把它写进 pid.json,
// 然后走真实的路由 handler。实测:改回旧行为(stop + 重新 launch)时 ①②④⑤ 必挂。
// ③(进程还活着)是额外保险,用来抓住"悄悄杀进程"这类回归;但在受限沙箱里 killTree 本身可能 EPERM
// (taskkill 走管道 spawn),所以它不作为唯一依据。
//
// 用法:node scripts/test-workspace-switch.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await Promise.race([fn(), new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout 30s')), 30000))]);
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 桩:本地 /healthz 服务 + 长活"IDE"子进程 + pid.json ----------------------------------
const dshHome = mkdtempSync(join(tmpdir(), 'dshcs-ws-home-'));
process.env.DSH_HOME = dshHome;

const health = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});
await new Promise((r) => health.listen(0, '127.0.0.1', r));
const port = health.address().port;

const fakeIde = spawn(process.execPath, ['-e', 'setInterval(function(){}, 1000)'], { stdio: 'ignore' });
await sleep(300);

const pidPath = join(dshHome, 'code-server', 'pid.json');
mkdirSync(join(dshHome, 'code-server'), { recursive: true });
// 0.2.14 起 launcher 走"路径令牌 + 随机端口":host 的探针与接管都要读令牌文件,没有它就认定
// "那个实例不是本代插件拉起来的",不接管 —— 所以这个测试必须把令牌文件写上。
writeFileSync(join(dshHome, 'code-server', 'path-token'), 'worktest-token-0123456789abcdef', 'utf8');
writeFileSync(pidPath, JSON.stringify({
  pid: fakeIde.pid,
  startedAt: Date.now(),
  cwd: 'C:/work/alpha',
  launchCwd: 'C:/work/alpha',
  host: '127.0.0.1',
  port,
  serve: 'loopback',
  pipe: null,
  launchKind: 'launcher',
  launchCommand: 'lib/launcher.mjs',
}, null, 2), 'utf8');

function makeStubCtx(routes) {
  return {
    get: (name) => {
      if (name === 'connection') {
        return { fetch: { register: (route) => { routes.set(route.path, route); return () => {}; } } };
      }
      if (name === 'settings') {
        return { resolve: () => ({}), get: () => ({}), onDidChange: () => ({ dispose() {} }) };
      }
      return undefined;
    },
    inject: () => () => {},
    effect: () => () => {},
    provide: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    log: () => {},
    on: () => () => {},
    emit: () => {},
    get config() { return undefined; },
    use: () => {},
  };
}

const plugin = await import('../lib/index.js');
const routes = new Map();
const userDataDir = mkdtempSync(join(tmpdir(), 'dshcs-ws-ud-'));
await plugin.apply(makeStubCtx(routes), {
  keepResident: false, serve: 'loopback', port, host: '127.0.0.1', userDataDir,
  claimExtensions: '*', fullscreenOnOpen: false,
});

const startRoute = routes.get('/api/code-server/start');
const post = async (cwd) => (await startRoute.fetch(new Request('http://x/api/code-server/start', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(cwd === undefined ? {} : { cwd }),
}))).json();

await test('adopt:进程已在跑且 pid.json 有效 → 首次 /start {cwd:A} 接管该实例', async () => {
  const snap = await post('C:/work/alpha');
  assert.equal(snap.status, 'running', `应接管为 running(实际 ${snap.status}: ${snap.error ?? ''})`);
  assert.equal(snap.pid, fakeIde.pid, 'pid 应指向被接管的进程');
  assert.equal(snap.adopted, true, 'adopted 应为 true');
  assert.equal(snap.cwd, 'C:/work/alpha');
  assert.equal(snap.launchCwd, 'C:/work/alpha', 'launchCwd 记录进程启动目录');
  assert.equal(isAlive(fakeIde.pid), true, '被接管的进程应仍在运行');
});

await test('切工作区:snapshot.cwd 变成新目录,status 仍 running,pid 不变', async () => {
  const snap = await post('C:/work/beta');
  assert.equal(snap.cwd, 'C:/work/beta', 'cwd 应跟随新工作区');
  assert.equal(snap.status, 'running', '切换不应改变运行状态');
  assert.equal(snap.pid, fakeIde.pid, 'pid 必须不变(证明没有 stop + 重新 launch)');
  assert.equal(snap.launchCwd, 'C:/work/alpha', 'launchCwd 保持进程启动目录(诊断用)');
  assert.equal(snap.adopted, true);
});

await test('切工作区不杀进程(旧行为会 killTree 掉它)', async () => {
  assert.equal(isAlive(fakeIde.pid), true, 'IDE 进程必须还活着');
  await sleep(400);
  assert.equal(isAlive(fakeIde.pid), true, '等待后仍应活着(没有异步收尾的 kill)');
});

await test('同目录重复 /start 是幂等空操作', async () => {
  const snap = await post('C:/work/beta');
  assert.equal(snap.cwd, 'C:/work/beta');
  assert.equal(snap.pid, fakeIde.pid);
  assert.equal(isAlive(fakeIde.pid), true);
});

await test('不带 cwd 的 /start 不改变当前目录(预启动/预热路径)', async () => {
  const snap = await post(undefined);
  assert.equal(snap.cwd, 'C:/work/beta', '无 cwd 时保留当前目录');
  assert.equal(snap.pid, fakeIde.pid);
  assert.equal(isAlive(fakeIde.pid), true);
});

// ---- 收尾 ---------------------------------------------------------------------------------
try { fakeIde.kill(); } catch { /* ignore */ }
await new Promise((r) => health.close(r));
rmSync(userDataDir, { recursive: true, force: true });
rmSync(dshHome, { recursive: true, force: true });
console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
