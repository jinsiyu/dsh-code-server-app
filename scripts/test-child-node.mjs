// scripts/test-child-node.mjs —— 「给 IDE 子进程挑真 Node」的单元测试(lib/child-node.mjs)
//
// 为什么要有:DSH Desktop 的宿主是 Electron 的 Node 模式,照旧用 process.execPath 起 launcher 时,
// VS Code 会激活只在 Electron 下生效的 asar 解析钩子,拒绝树外的原生包 ⇒ 桌面版必炸 exit 2
// (实测首行:`Cannot find package '@vscode/spdlog' within the application resources`)。
// 这里把"该挑谁 / 环境要不要改 / 挑不到怎么退"三条钉死 —— 本机是普通 node 布局,不写死就永远测不到。
//
// 用法:node scripts/test-child-node.mjs
import assert from 'node:assert/strict';
import {
  childNodeCandidates,
  childNodeEnv,
  isElectronHost,
  resolveChildNode,
} from '../lib/child-node.mjs';

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

const WIN = 'win32';
const APP = 'C:\\App';
const EXE = 'C:\\App\\DeepSeek Harness.exe';
const RES = 'C:\\App\\resources';
const BUNDLED = `${RES}\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe`;
const ELECTRON_ENV = { ELECTRON_RUN_AS_NODE: '1', PATH: 'C:\\Windows;C:\\Program Files\\nodejs' };
/** 只让指定集合"存在"。 */
const existsOnly = (...paths) => (p) => paths.includes(p);

await test('宿主判据:versions.electron 或 ELECTRON_RUN_AS_NODE 任一命中就算 Electron 宿主', async () => {
  assert.equal(isElectronHost({ electron: '38.0.0' }, {}), true);
  assert.equal(isElectronHost({}, { ELECTRON_RUN_AS_NODE: '1' }), true);
  assert.equal(isElectronHost({}, { ELECTRON_RUN_AS_NODE: '0' }), false);
  assert.equal(isElectronHost({ node: '24.21.0' }, {}), false);
});

await test('普通 node 宿主:原样用 process.execPath,不换也不动环境(web/CLI 行为不变)', async () => {
  const resolved = resolveChildNode({ execPath: EXE, versions: { node: '24.21.0' }, env: { PATH: '' }, exists: existsOnly(BUNDLED) });
  assert.equal(resolved.command, EXE);
  assert.equal(resolved.swapped, false);
  assert.equal(resolved.electronHost, false);
  assert.equal(resolved.source, 'host-node');
  assert.deepEqual(childNodeEnv(resolved, { A: '1', ELECTRON_RUN_AS_NODE: '1' }), { A: '1', ELECTRON_RUN_AS_NODE: '1' });
});

await test('Electron 宿主:优先用应用自带的 primary-runtime node(实测唯一可用的那条)', async () => {
  const resolved = resolveChildNode({ execPath: EXE, resourcesPath: RES, platform: WIN, env: ELECTRON_ENV, exists: existsOnly(BUNDLED) });
  assert.equal(resolved.command, BUNDLED);
  assert.equal(resolved.swapped, true);
  assert.equal(resolved.source, 'app-primary-runtime-node');
});

await test('Electron 宿主:子进程环境必须剥掉 ELECTRON_RUN_AS_NODE(否则真 Node 也会激活那条钩子)', async () => {
  const resolved = resolveChildNode({ execPath: EXE, resourcesPath: RES, platform: WIN, env: ELECTRON_ENV, exists: existsOnly(BUNDLED) });
  const env = childNodeEnv(resolved, { ...ELECTRON_ENV, DSHCS_HTML_TAG: 'keep-me' });
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false);
  assert.equal(env.DSHCS_HTML_TAG, 'keep-me', '其它变量照旧传下去');
  assert.equal(env.PATH, ELECTRON_ENV.PATH);
  // 退回 Electron 时反而要留着它,否则 Electron 会当 GUI 启动
  const fallback = resolveChildNode({ execPath: EXE, resourcesPath: RES, platform: WIN, env: ELECTRON_ENV, exists: () => false });
  assert.equal(childNodeEnv(fallback, { ELECTRON_RUN_AS_NODE: '1' }).ELECTRON_RUN_AS_NODE, '1');
});

await test('Electron 宿主:候选顺序 fixed(自带 > 旧布局 > resources/node > 可执行文件旁 > PATH)', async () => {
  const list = childNodeCandidates({ execPath: EXE, resourcesPath: RES, platform: WIN, env: { PATH: 'D:\\tools' } });
  assert.deepEqual(list.map((c) => c.source).slice(0, 3), ['app-primary-runtime-node', 'app-runtime-node', 'app-resources-node']);
  assert.ok(list.some((c) => c.source === 'path-node'));
  // resourcesPath 与 execPath 推出来的是同一个目录时,按路径去重(不重复探测同一个文件)
  assert.equal(list.filter((c) => c.path === BUNDLED).length, 1);
  // resourcesPath 拿不到(Electron 之外的宿主形态)→ 才会有独立的 exec-side 候选
  const withoutResources = childNodeCandidates({ execPath: EXE, platform: WIN, env: { PATH: '' } });
  assert.deepEqual(withoutResources.map((c) => c.source), ['exec-side-runtime-node', 'exec-side-node']);
});

await test('Electron 宿主 + PATH 上有 node:用它(并且跳过应用 resources 里的 Electron shim)', async () => {
  const sysNode = 'C:\\Program Files\\nodejs\\node.exe';
  const shim = `${RES}\\runtime\\bin\\node.exe`; // 假想:应用私有的 node 目录也在 PATH 上
  const env = { ...ELECTRON_ENV, PATH: `${RES}\\runtime\\bin;C:\\Windows;C:\\Program Files\\nodejs` };
  const resolved = resolveChildNode({ execPath: EXE, resourcesPath: RES, platform: WIN, env, exists: existsOnly(sysNode, shim) });
  assert.equal(resolved.command, sysNode, '应跳过 resources 下的 shim,选真正的系统 node');
  assert.equal(resolved.source, 'path-node');
  // 候选表本身也不该把 resources 内的 PATH 项收进来
  assert.ok(!childNodeCandidates({ execPath: EXE, resourcesPath: RES, platform: WIN, env }).some((c) => c.path === shim));
});

await test('DSH_DESKTOP_NODE_EXECUTABLE 指向 Electron 时不采信(实测它就是 Electron 自己)', async () => {
  const electronHint = `${APP}\\DeepSeek Harness.exe`;
  const list = childNodeCandidates({
    execPath: EXE, resourcesPath: RES, platform: WIN,
    env: { PATH: '', DSH_DESKTOP_NODE_EXECUTABLE: electronHint },
  });
  assert.ok(!list.some((c) => c.path === electronHint));
  // 真指向 node 二进制时才认
  const okNode = 'D:\\node\\node.exe';
  const list2 = childNodeCandidates({ execPath: EXE, resourcesPath: RES, platform: WIN, env: { PATH: '', DSH_DESKTOP_NODE_EXECUTABLE: okNode } });
  assert.ok(list2.some((c) => c.path === okNode && c.source === 'env-dsh-desktop-node'));
});

await test('Electron 宿主 + 一个真 node 都没有:退回 Electron 并如实上报(调用方据此告警)', async () => {
  const resolved = resolveChildNode({ execPath: EXE, resourcesPath: RES, platform: WIN, env: { PATH: '', ELECTRON_RUN_AS_NODE: '1' }, exists: () => false });
  assert.equal(resolved.command, EXE);
  assert.equal(resolved.swapped, false);
  assert.equal(resolved.source, 'electron-fallback');
  assert.equal(resolved.electronHost, true);
});

await test('Linux/macOS 形态:候选用无扩展名的 node', async () => {
  const resolved = resolveChildNode({
    execPath: '/opt/app/deepseek-harness', resourcesPath: '/opt/app/resources', platform: 'linux',
    env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
    exists: existsOnly('/opt/app/resources/runtime/primary-runtime/dependencies/node/bin/node'),
  });
  assert.equal(resolved.command, '/opt/app/resources/runtime/primary-runtime/dependencies/node/bin/node');
  assert.equal(resolved.source, 'app-primary-runtime-node');
});

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
