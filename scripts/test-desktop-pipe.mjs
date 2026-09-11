// scripts/test-desktop-pipe.mjs —— 桌面管道模式的端到端验证(0.3.2)
//
// 为什么需要:0.3.2 把 desktop 的传输从"回环端口"换成"命名管道",而"管道能被监听"与
// "扩展宿主能连上"是两个独立条件(§15:只给 --pipe 不给 --exthost-ipc 会得到起得来但扩展
// 宿主连不上的假成功)。单元测试只能验证参数拼装,这个脚本跑**真实 IDE**兜底。
//
// 做法:用桩 ctx 真跑插件的 apply(),再经 /api/code-server/start 路由启动真实 VS Code,
// 断言 ①transport=pipe ②状态里 port=null、url=资产镜像文档 ③管道上 /healthz 就绪
//      ④launcher 进程**没有任何 TCP 监听** ⑤stop 后进程退出。
//
// 目标代码默认取 desktop profile 里**已部署**的那份(只有 profile 里才有平台预编译原生包);
// 用 --plugin <dir> 覆盖,未部署时以 SKIP 退出(不误报失败)。
//
// 用法:node scripts/test-desktop-pipe.mjs [--plugin <dir>] [--keep]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// **测试隔离(必做)**:插件的 dataRoot/pid.json 由 DSH_HOME 决定,默认与桌面 App 共用
// ~/.dsh/code-server。不隔离的话,apply 期的 activation adopt 会探到**正在运行的 App 实例**
// (管道记录跨进程可探活)并接管,随后的 stop 会把用户的 IDE 杀掉(2026-09-11 真实踩到)。
// 必须在 import 插件之前改掉 DSH_HOME。
process.env.DSH_HOME = join(tmpdir(), `dshcs-pipe-home-${process.pid}`);
mkdirSync(join(process.env.DSH_HOME, 'code-server'), { recursive: true });

const argv = process.argv.slice(2);
const flagValue = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const PLUGIN_DIR = flagValue('--plugin', join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-code-server-app'));
const KEEP = argv.includes('--keep');

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

/** 桩 ctx(与 test-plugin-apply.mjs 同源):connection.fetch.register + settings。 */
function makeStubCtx({ routes, registered }) {
  const settingsValue = { keepResident: false, fileOpenScope: 'session', serve: 'loopback', port: 18099 };
  return {
    get: (name) => {
      if (name === 'connection') {
        return {
          fetch: {
            register: (route) => {
              registered.push(route);
              routes.set(route.path, route);
              return () => {};
            },
          },
        };
      }
      if (name === 'settings') return { resolve: () => settingsValue, get: () => settingsValue, onDidChange: () => ({ dispose() {} }) };
      return undefined;
    },
    inject: () => () => {}, // webServer 等可选依赖:桩里就是"不存在" → desktop 分支
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

function healthOnPipe(pipe, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = request({ socketPath: pipe, path: '/healthz', method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.end();
  });
}

/** netstat 里属于该 pid 的 TCP LISTENING 行(拿不到 netstat 时返回 null,不误判)。 */
function listeningTcpLines(pid) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 15000 });
    return out.split('\n').map((line) => line.trim())
      .filter((line) => /^TCP\S*\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/.test(line) && line.endsWith(` ${pid}`));
  } catch {
    return null;
  }
}

async function jsonOf(response) {
  const text = await response.text();
  return JSON.parse(text);
}

if (!existsSync(join(PLUGIN_DIR, 'lib', 'index.js'))) {
  console.log(`SKIP 未部署插件副本(${PLUGIN_DIR} 不存在);先跑 node scripts/dev-deploy.mjs`);
  process.exit(0);
}

const userDataDir = mkdtempSync(join(process.env.TEMP ?? '.', 'dshcs-pipe-e2e-'));
const routes = new Map();
const registered = [];
const plugin = await import(new URL(`file://${join(PLUGIN_DIR, 'lib', 'index.js').replace(/\\/g, '/')}`).href);
const ctx = makeStubCtx({ routes, registered });
await plugin.apply(ctx, {
  keepResident: false,
  fileOpenScope: 'session',
  serve: 'loopback',
  userDataDir,
});

let status = null;
try {
  const startRoute = routes.get('/api/code-server/start');
  const statusRoute = routes.get('/api/code-server/status');
  assert.ok(startRoute !== undefined && statusRoute !== undefined, 'start/status 路由必须已注册');

  await test('start:desktop 走命名管道(transport=pipe / 无 port 字段 / url=资产镜像文档)', async () => {
    const started = await jsonOf(await startRoute.fetch({ json: async () => ({}) }));
    assert.notEqual(started.status, 'error', `启动不应直接报错:${started.error ?? ''}`);
    const deadline = Date.now() + 90000;
    for (;;) {
      const current = await jsonOf(await statusRoute.fetch({}));
      if (current.running === true || current.status === 'error') { status = current; break; }
      if (Date.now() > deadline) { status = current; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(status.status, 'running', `IDE 应就绪:${String(status.error ?? '').slice(0, 400)}`);
    console.log(`     pid=${status.pid} transport=${status.transport} pipe=${status.pipe}`);
    assert.equal(status.transport, 'pipe', '管道是唯一传输');
    assert.ok(typeof status.pipe === 'string' && status.pipe.includes('pipe'), `pipe 名应可读:${status.pipe}`);
    assert.equal('port' in status, false, '0.3.3 起状态里不再有 port 字段(没有端口这条路)');
    assert.equal('host' in status, false, '0.3.3 起状态里不再有 host 字段');
    assert.equal(status.serve, 'loopback');
    assert.equal(status.url, '/api/code-server/asset/index.html', '客户端的文档只能来自同源资产镜像');
  });

  await test('IDE 真的监听在命名管道上(/healthz)', async () => {
    assert.ok(status !== null && typeof status.pipe === 'string', '上游断言失败时跳过');
    const probe = await healthOnPipe(status.pipe);
    assert.equal(probe.ok, true, `管道 /healthz 应 200(实际 ${probe.status ?? 'error'})`);
    assert.match(probe.body, /"ok":true/, 'healthz 载荷应含 ok:true');
    assert.match(probe.body, /"mode":"pipe"/, 'launcher 应自报管道模式');
  });

  await test('launcher 进程没有任何 TCP 监听端口', async () => {
    const lines = listeningTcpLines(status.pid);
    if (lines === null) {
      console.log('     (netstat 不可用,跳过端口断言)');
      return;
    }
    assert.deepEqual(lines, [], `不该有 TCP 监听:${lines.join(' | ')}`);
  });

  await test('资产镜像路由已注册(客户端零依赖端口的前提)', async () => {
    assert.ok(registered.some((r) => r.path.startsWith('/api/code-server/asset/')), '镜像路由必须存在');
    assert.equal(status.assetMirror.enabled === false, false, '镜像不应被禁用');
    assert.ok(status.assetMirror.registered > 0, '镜像应注册了路由');
  });

  await test('stop:进程退出且状态收敛', async () => {
    const stopRoute = routes.get('/api/code-server/stop');
    const stopped = await jsonOf(await stopRoute.fetch({}));
    assert.equal(stopped.running, false, 'stop 后不应仍在运行');
    assert.equal(stopped.status, 'stopped');
  });
} finally {
  if (!KEEP) {
    // stop 之后子进程树还在收尾(文件句柄未释放)→ 重试几次,清理失败不影响结论。
    for (let i = 0; i < 5; i += 1) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 700));
      }
    }
  } else {
    console.log(`保留 ${userDataDir}`);
  }
}

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
