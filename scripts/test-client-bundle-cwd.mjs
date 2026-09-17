// scripts/test-client-bundle-cwd.mjs —— 直接对**构建产物** lib/client.js 验"工作区跟随"这条链
//
// 为什么不能只测 src/workspace.js:0.3.46 的坑不在解析函数里,而在**产物怎么拿输入** ——
// 它从 `useSessions(s => s).current` 里读"当前会话",而 DSH 0.1.6-alpha.2 把这个字段从
// SessionListState 移除了 ⇒ 客户端不再发 cwd ⇒ IDE 以空工作区启动(实测 pid.json 里 cwd 双空)。
// 纯函数测试对"喂什么形状"是无感的,只有真跑一遍注册出来的 React 组件、喂进两版 DSH 的
// 标准 prop 形状,才能钉住这条契约。
//
// 做法:用最小的 window/__ModuleLoader__/react/ctx/slots 桩把产物加载起来,拿到它注册到
// `sidebar.right.pane.tab` 的 body 与 `shell.overlay` 的预热面,**直接调用**(桩 react 的 hook
// 按调用次数记账、effect 立即执行),然后看两件事:
//   1. 它以什么 cwd 打 `POST /api/code-server/start`(这才是 0.3.46 漏掉的那一步);
//   2. 它交给常驻 iframe 的 pageUrl(决定 workbench 用哪个 `?folder=` 打开)。
// 场景覆盖:DSH ≥ 0.1.6-alpha.2(sessionId 标准 prop)、DSH ≤ 0.1.6-alpha.1(快照上的 current)、
// 换会话、文件 tab(地址里的会话)、两版信源都没有(不得猜目录)、根作用域预热面。
//
// 产物缺失或比源码旧时 SKIP(exit 0)—— 与 test-webview-bundle.mjs 同一套约定:
// 没构建就"报绿"是假绿,但要的是显式的 SKIP 行,不是静默通过。
//
// 用法:node scripts/build-client.mjs && node scripts/test-client-bundle-cwd.mjs
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

let pass = 0;
let fail = 0;
let skip = 0;
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

// ---------- 产物新鲜度 ----------
const bundlePath = join(pkgRoot, 'lib', 'client.js');
const sources = ['src/factory.js', 'src/workspace.js', 'src/surface.js', 'src/sidebar-mode.js', 'src/address.js'];
let bundle;
try {
  bundle = readFileSync(bundlePath, 'utf8');
} catch {
  console.log(`SKIP 产物不存在(${bundlePath});先跑 node scripts/build-client.mjs`);
  console.log('SUMMARY pass=0 fail=0 skip=1');
  process.exit(0);
}
const stale = sources.filter((rel) => {
  try { return statSync(join(pkgRoot, rel)).mtimeMs > statSync(bundlePath).mtimeMs; } catch { return false; }
});
if (stale.length > 0) {
  console.log(`SKIP 产物比源码旧(${stale.join(', ')} 更新);先跑 node scripts/build-client.mjs`);
  console.log('SUMMARY pass=0 fail=0 skip=1');
  process.exit(0);
}

// ---------- 极简 react 桩:hook 按调用次数记账,单次渲染即可(effect 立即执行) ----------
function createFakeReact() {
  let cells = [];
  let index = 0;
  return {
    reset() { cells = []; index = 0 },
    React: {
      createElement(type, props, ...children) {
        const next = { ...(props === null || props === undefined ? {} : props) };
        if (children.length === 1) next.children = children[0];
        else if (children.length > 1) next.children = children;
        return { type, props: next };
      },
      useRef(initial) {
        const at = index++;
        if (cells[at] === undefined) cells[at] = { current: initial };
        return cells[at];
      },
      useState(initial) {
        const at = index++;
        if (cells[at] === undefined) cells[at] = { value: initial };
        const cell = cells[at];
        return [cell.value, (v) => { cell.value = typeof v === 'function' ? v(cell.value) : v }];
      },
      // 立即执行:被测的正是"effect 里发出的请求 / 设置的 iframe src",不执行就等于没测
      useEffect(fn) { index += 1; const out = fn(); return typeof out === 'function' ? out : undefined; },
      useLayoutEffect(fn) { index += 1; const out = fn(); return typeof out === 'function' ? out : undefined; },
      useSyncExternalStore(subscribe, getSnapshot) { index += 1; return getSnapshot(); },
    },
  };
}

/** 极简 DOM 节点:surface.js 建停放区/iframe 要用到的那几个成员。 */
function createFakeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    className: '',
    src: '',
    setAttribute(name, value) { el.attributes[name] = String(value) },
    removeAttribute(name) { delete el.attributes[name] },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(el.attributes, name) },
    appendChild(child) { el.children.push(child); return child },
    removeChild(child) { el.children = el.children.filter((c) => c !== child); return child },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 } },
    querySelector() { return null },
    closest() { return null },
  };
  return el;
}

/** 加载产物:window.__ModuleLoader__ 收 factory → 用桩 require 取 module.exports。 */
function loadBundle() {
  const fake = createFakeReact();
  const loaded = [];
  globalThis.window = {
    __ModuleLoader__: { load: (entry) => loaded.push(entry) },
    // 组件 effect 里会挂状态轮询;桩成"永不触发",测试只跑一次渲染
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  globalThis.document = {
    head: createFakeElement('head'),
    body: createFakeElement('body'),
    createElement: (tag) => createFakeElement(tag),
    getElementById: () => null,
    // 非 null = "样式已注入",跳过真正的 DOM 操作
    querySelector: () => ({}),
  };
  const statusPayload = {
    ok: true, running: true, status: 'running', pid: 9600, startedAt: 1789657770119,
    url: 'http://127.0.0.1:8090/tok/', serve: 'loopback', keepResident: true,
    fullscreenOnOpen: true, claimExtensions: '*',
  };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    let body = null;
    if (options !== undefined && options !== null && typeof options.body === 'string') {
      try { body = JSON.parse(options.body) } catch { body = options.body }
    }
    calls.push({ url: String(url), method: (options && options.method) || 'GET', body });
    return { ok: true, status: 200, text: async () => JSON.stringify(statusPayload) };
  };
  new Function('window', 'document', 'fetch', 'setTimeout', 'setInterval', 'clearInterval', 'console', bundle)(
    globalThis.window, globalThis.document, globalThis.fetch,
    (fn) => { void fn; return 0 }, () => 0, () => {}, console,
  );
  assert.equal(loaded.length, 1, '产物应恰好调用一次 __ModuleLoader__.load');
  const entry = loaded[0];
  assert.equal(entry.id, 'dsh-code-server-app');
  const exports = entry.factory((name) => {
    if (name === 'react') return fake.React;
    if (name === 'react/jsx-runtime') return { jsx: fake.React.createElement, jsxs: fake.React.createElement };
    throw new Error(`未知模块:${name}`);
  });
  assert.equal(typeof exports.apply, 'function');
  const registrations = [];
  const slots = {
    register: (desc, component) => { registrations.push({ desc, component }); return () => {}; },
    inject: (name, factory) => { const out = factory(); return typeof out === 'function' ? out : () => {}; },
  };
  const sidebarRightTabs = { register: () => () => {}, guide: () => [], entries: () => [], subscribe: () => () => {} };
  const sidebarRight = { bind: () => {}, openTab: () => {}, closeIn: () => {}, isExpanded: () => false, toggleExpanded: () => {} };
  const ctx = {
    get: (name) => (name === 'slots' ? slots : undefined),
    sidebarRightTabs, sidebarRight, slots,
    settingsScope: {
      bind: () => ({
        getSnapshot: () => ({ status: 'ready', value: {}, user: {}, writable: true }),
        subscribe: () => () => {},
        set: async () => {}, unset: async () => {},
      }),
    },
    inject: (deps, cb) => { cb(ctx); return () => {}; },
    effect: (fn) => { const out = fn(); return typeof out === 'function' ? out : () => {}; },
  };
  exports.apply(ctx);
  return { fake, registrations, calls };
}

const { fake, registrations, calls } = loadBundle();
const bodyReg = registrations.find((r) => r.desc.name === 'sidebar.right.pane.tab');
const residentReg = registrations.find((r) => r.desc.name === 'shell.overlay');

/** 渲染一次(每次调用前清空 hook 记账);effect 会同步执行,发出的请求落在 calls 里。
 *  注册面有的是包装组件(`(props) => <Resident {...props} />`);body 里真正去设 iframe src 的
 *  常驻面是**子组件**(CodeServerSurface),所以沿"函数子组件"下钻一层层调用,直到没有为止。 */
function render(component, props) {
  fake.reset();
  let tree = component(props);
  if (tree != null && typeof tree.type === 'function') tree = tree.type(tree.props !== undefined ? tree.props : props);
  let node = tree;
  for (let depth = 0; depth < 4 && node != null; depth += 1) {
    const kids = node.props !== undefined ? node.props.children : undefined;
    const list = Array.isArray(kids) ? kids : (kids === undefined || kids === null ? [] : [kids]);
    const child = list.find((k) => k != null && typeof k.type === 'function');
    if (child === undefined) break;
    node = child.type(child.props !== undefined ? child.props : {});
  }
  return tree;
}

/** 最后一次 POST /api/code-server/start 的 cwd(没发过则 undefined)。 */
function lastStartCwd() {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (calls[i].url.endsWith('/api/code-server/start') && calls[i].method === 'POST') return calls[i].body ? calls[i].body.cwd : undefined;
  }
  return undefined;
}
const surfaceSrc = () => globalThis.window.__dshcsSurface.snapshot().src;

const tabProps = ({ sessionId, sessions, workspaces, address }) => ({
  sessionId,
  useSessions: (selector) => selector(sessions),
  useWorkspaces: (selector) => selector(workspaces),
  useTabInfo: () => ({
    tab: { id: 'tab-1', navigation: { address: address !== undefined ? address : 'sidebar://code-server', revision: 0 }, visible: true },
    sidebar: { fullscreen: true },
  }),
});

const ALPHA2 = { ids: ['b'], byId: { b: { id: 'b', cwd: 'C:/work/beta' } }, phase: 'ready', subagentsByParent: {}, jobsBySession: {} };
const ALPHA1 = { ids: ['a'], byId: { a: { id: 'a', cwd: 'C:/work/alpha' } }, current: 'a', phase: 'ready' };
const NO_WS = { items: [], state: 'idle', phase: 'ready', error: null };
const folderOf = (cwd) => '&folder=' + encodeURIComponent('/' + cwd.replace(/\\/g, '/'));

// 先等一次 apply 期的 /status 预取落地(store 里要有 status,否则 body 渲染的是"未运行"空态)
await new Promise((resolve) => setTimeout(resolve, 0));

await test('注册面:body 挂在 sidebar.right.pane.tab,预热面挂在 shell.overlay', async () => {
  assert.ok(bodyReg, '应注册 sidebar.right.pane.tab 的 body');
  assert.equal(bodyReg.desc.key, 'dsh-code-server-app');
  assert.ok(residentReg, '应注册 shell.overlay 的常驻预热面');
  assert.ok(calls.some((c) => c.url.includes('/api/code-server/status')), 'apply 期应先拉一次 status');
});

await test('DSH 0.1.6-alpha.2 形状:sessionId 标准 prop → /start 带 cwd 且 pageUrl 带 ?folder=', async () => {
  render(bodyReg.component, tabProps({ sessionId: 'b', sessions: ALPHA2, workspaces: NO_WS }));
  assert.equal(lastStartCwd(), 'C:/work/beta', '必须把该会话的工作区交给宿主(0.3.46 在这里漏了)');
  const src = surfaceSrc();
  assert.match(src, /\?s=9600/, '实例标记要在');
  assert.ok(src.includes(folderOf('C:/work/beta')), `folder 应是 /C:/work/beta,实际:${src}`);
});

await test('DSH 0.1.6-alpha.1 形状:快照上的 current 仍然认(向后兼容)', async () => {
  render(bodyReg.component, tabProps({ sessionId: undefined, sessions: ALPHA1, workspaces: NO_WS }));
  assert.equal(lastStartCwd(), 'C:/work/alpha');
  assert.ok(surfaceSrc().includes(folderOf('C:/work/alpha')), `实际:${surfaceSrc()}`);
});

await test('切换会话(sessionId 变化)会把工作区换到新目录', async () => {
  const sessions = { ids: ['a', 'b'], byId: { a: { id: 'a', cwd: 'C:/work/alpha' }, b: { id: 'b', cwd: 'C:/work/beta' } }, phase: 'ready' };
  render(bodyReg.component, tabProps({ sessionId: 'a', sessions, workspaces: NO_WS }));
  assert.equal(lastStartCwd(), 'C:/work/alpha');
  render(bodyReg.component, tabProps({ sessionId: 'b', sessions, workspaces: NO_WS }));
  assert.equal(lastStartCwd(), 'C:/work/beta');
  assert.ok(surfaceSrc().includes(folderOf('C:/work/beta')));
});

await test('文件 tab:地址里的会话决定工作区(看别的会话的文件不串目录)', async () => {
  const sessions = { ids: ['b'], byId: { other: { id: 'other', cwd: 'D:/repo/other' } }, phase: 'ready' };
  render(bodyReg.component, tabProps({
    sessionId: 'b', sessions, workspaces: NO_WS,
    address: 'dsh-resource://file/session/other/src/a.ts',
  }));
  assert.equal(lastStartCwd(), 'D:/repo/other', '文件 tab 用地址里的会话');
  assert.ok(surfaceSrc().includes(folderOf('D:/repo/other')), `实际:${surfaceSrc()}`);
});

await test('两版信源都没有 → 不猜目录(不发 cwd,pageUrl 不带 folder)', async () => {
  const before = calls.length;
  render(bodyReg.component, tabProps({ sessionId: undefined, sessions: { ids: [], byId: {}, phase: 'ready' }, workspaces: NO_WS }));
  const started = calls.slice(before).filter((c) => c.url.endsWith('/api/code-server/start'));
  assert.equal(started.length, 0, '没有工作区时不应发 /start(免得把实例的目录改成空)');
  const src = surfaceSrc();
  assert.ok(typeof src === 'string' && src !== '');
  assert.ok(!src.includes('folder='), `没有信源时不应带 folder,实际:${src}`);
});

await test('根作用域预热面:无 sessionId 也能退到"最近活跃会话所属工作区"', async () => {
  const sessions = { ids: ['recent'], byId: { recent: { id: 'recent' } }, phase: 'ready' };
  const workspaces = { items: [{ workspaceId: 'w', path: 'C:/work/team', sessionIds: ['recent'] }], state: 'idle', phase: 'ready', error: null };
  render(residentReg.component, {
    useSessions: (selector) => selector(sessions),
    useWorkspaces: (selector) => selector(workspaces),
  });
  assert.ok(surfaceSrc().includes(folderOf('C:/work/team')), `预热 src 应带 team 工作区,实际:${surfaceSrc()}`);
});

console.log(`SUMMARY pass=${pass} fail=${fail} skip=${skip}`);
process.exit(fail === 0 ? 0 : 1);
