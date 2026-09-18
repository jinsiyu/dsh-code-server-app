// scripts/client-bundle-harness.mjs —— 把构建产物 lib/client.js 装进"最小 DSH"里跑起来
//
// 为什么值得单独一个模块:插件真正的契约在**浏览器侧** —— 它注册到哪些插槽、拿什么 props 渲染、
// 发什么请求。这些既不是纯函数也不是 host 行为,只有把产物加载起来、喂进一段假 prop/假 ctx 才能
// 钉住。0.3.48(DSH 0.1.6-alpha.2 去掉 SessionListState.current)与 0.3.50(设置卡从
// settings.plugin.item 搬到插件页 plugins.bundle.config)两次都是"本机看不出、一升级就静默失效",
// 所以回归必须落在这一层。
//
// 提供的能力(刻意保持最小、够用即止):
//   · window.__ModuleLoader__ / document / fetch / setInterval 桩;
//   · 极简 react 桩:hook 按调用次数记账,effect **立即执行**(被测的正是 effect 里的请求与 iframe src);
//   · slots 桩:`inject(name, factory)` **只在声明的插槽列表里回调**(复刻 DSH "插槽未被声明就不回调"
//     的语义);register 把每个 entry 的 desc 与组件留下来;
//   · 渲染:调一次组件(可选沿"函数子组件"下钻一层层调),返回它渲染出的元素树。
//
// 用法:
//   import { loadClientBundle } from './client-bundle-harness.mjs'
//   const h = loadClientBundle({ declaredSlots: ['sidebar.right.pane.tab', 'shell.overlay'] })
//   const reg = h.registrations.find(r => r.desc.name === 'plugins.bundle.config')
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const pkgRoot = join(here, '..');

/** 产物新鲜度:缺失或比源码旧时返回原因字符串(调用方据此 SKIP),否则 null。 */
export function bundleStaleness() {
  const bundlePath = join(pkgRoot, 'lib', 'client.js');
  const sources = ['src/factory.js', 'src/workspace.js', 'src/surface.js', 'src/sidebar-mode.js', 'src/address.js'];
  try {
    readFileSync(bundlePath);
  } catch {
    return `产物不存在(${bundlePath})`;
  }
  const stale = sources.filter((rel) => {
    try { return statSync(join(pkgRoot, rel)).mtimeMs > statSync(bundlePath).mtimeMs; } catch { return false; }
  });
  return stale.length > 0 ? `产物比源码旧(${stale.join(', ')} 更新)` : null;
}

/** 极简 react:hook 按调用次数记账,单次渲染即可;effect 立即执行。 */
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
        if (cells[at] === undefined) cells[at] = { value: typeof initial === 'function' ? initial() : initial };
        const cell = cells[at];
        return [cell.value, (v) => { cell.value = typeof v === 'function' ? v(cell.value) : v }];
      },
      useEffect(fn) { index += 1; const out = fn(); return typeof out === 'function' ? out : undefined; },
      useLayoutEffect(fn) { index += 1; const out = fn(); return typeof out === 'function' ? out : undefined; },
      useSyncExternalStore(subscribe, getSnapshot) { index += 1; return getSnapshot(); },
    },
  };
}

function createFakeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {}, dataset: {}, attributes: {}, children: [], className: '', src: '',
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

const DEFAULT_STATUS = {
  ok: true, running: true, status: 'running', pid: 9600, startedAt: 1789657770119,
  url: 'http://127.0.0.1:8090/tok/', serve: 'loopback', keepResident: true,
  fullscreenOnOpen: true, claimExtensions: '*',
};

/**
 * 加载产物并 apply 一次。
 * @param options.declaredSlots 已声明的插槽名(不在此列 ⇒ inject 不回调,与 DSH 行为一致)
 * @param options.status `/api/code-server/status` 的返回体
 * @param options.scopeSnapshot settingsScope.bind(...).getSnapshot() 的返回体
 */
export function loadClientBundle(options = {}) {
  const declared = new Set(options.declaredSlots ?? []);
  const statusPayload = options.status ?? DEFAULT_STATUS;
  const scopeSnapshot = options.scopeSnapshot ?? { status: 'ready', value: {}, user: {}, writable: true };
  const fake = createFakeReact();
  const loaded = [];
  globalThis.window = {
    __ModuleLoader__: { load: (entry) => loaded.push(entry) },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
  };
  globalThis.document = {
    head: createFakeElement('head'),
    body: createFakeElement('body'),
    createElement: (tag) => createFakeElement(tag),
    getElementById: () => null,
    querySelector: () => ({}), // 非 null = 样式已注入,跳过真实 DOM 操作
  };
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    let body = null;
    if (opts != null && typeof opts.body === 'string') {
      try { body = JSON.parse(opts.body) } catch { body = opts.body }
    }
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body });
    return { ok: true, status: 200, text: async () => JSON.stringify(statusPayload) };
  };
  const bundle = readFileSync(join(pkgRoot, 'lib', 'client.js'), 'utf8');
  new Function('window', 'document', 'fetch', 'setTimeout', 'setInterval', 'clearInterval', 'console', bundle)(
    globalThis.window, globalThis.document, globalThis.fetch,
    (fn) => { void fn; return 0 }, () => 0, () => {}, console,
  );
  assert.equal(loaded.length, 1, '产物应恰好调用一次 __ModuleLoader__.load');
  const entry = loaded[0];
  assert.equal(entry.id, 'dsh-code-server-app');
  const mod = entry.factory((name) => {
    if (name === 'react') return fake.React;
    if (name === 'react/jsx-runtime') return { jsx: fake.React.createElement, jsxs: fake.React.createElement };
    throw new Error(`未知模块:${name}`);
  });
  assert.equal(typeof mod.apply, 'function');

  const registrations = [];
  const injects = [];
  const slots = {
    register: (desc, component) => { registrations.push({ desc, component }); return () => {}; },
    inject: (name, factory) => {
      // 与 DSH 一致:插槽没被声明就不回调(声明是别人的事,顺序不保证 ⇒ 只有声明了才会回调)
      if (!declared.has(name)) return () => {};
      const out = factory();
      injects.push({ name, out });
      return typeof out === 'function' ? out : () => {};
    },
  };
  const ctx = {
    get: (name) => (name === 'slots' ? slots : undefined),
    sidebarRightTabs: { register: () => () => {}, guide: () => [], entries: () => [], subscribe: () => () => {} },
    sidebarRight: { bind: () => {}, openTab: () => {}, closeIn: () => {}, isExpanded: () => false, toggleExpanded: () => {} },
    slots,
    settingsScope: {
      bind: () => ({
        getSnapshot: () => scopeSnapshot,
        subscribe: () => () => {},
        set: async () => {}, unset: async () => {},
      }),
    },
    inject: (deps, cb) => { cb(ctx); return () => {}; },
    effect: (fn) => { const out = fn(); return typeof out === 'function' ? out : () => {}; },
  };
  mod.apply(ctx);

  /** 渲染一次:重置 hook 记账,再把**整棵树的函数组件都调用掉**(深度上限 8),
   *  直到剩下宿主元素与字符串 —— 断言才看得到真正的控件(如 textarea)与全部文案。
   *  effect 立即执行(app 里真正的请求/iframe src 就发生在 effect 里)。 */
  function renderTree(node, depth) {
    if (node === null || node === undefined || depth > 8) return node;
    if (typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((child) => renderTree(child, depth));
    if (typeof node.type === 'function') return renderTree(node.type(node.props !== undefined ? node.props : {}), depth + 1);
    const props = node.props === undefined ? {} : node.props;
    if (props.children === undefined) return node;
    return { type: node.type, props: { ...props, children: renderTree(props.children, depth + 1) } };
  }
  function render(component, props) {
    fake.reset();
    return renderTree(component(props), 0);
  }

  return {
    registrations,
    injects,
    calls,
    render,
    statusPayload,
    scopeSnapshot,
    /** 常驻面的当前 src(surface.js 暴露的排障句柄)。 */
    surfaceSrc: () => globalThis.window.__dshcsSurface.snapshot().src,
    /** 最后一次 POST /api/code-server/start 的 cwd。 */
    lastStartCwd: () => {
      for (let i = calls.length - 1; i >= 0; i -= 1) {
        if (calls[i].url.endsWith('/api/code-server/start') && calls[i].method === 'POST') {
          return calls[i].body ? calls[i].body.cwd : undefined;
        }
      }
      return undefined;
    },
  };
}

/** 从元素树里把所有字符串叶子拼起来(断言文案用)。 */
export function textOf(tree) {
  if (tree === null || tree === undefined || typeof tree === 'boolean') return '';
  if (typeof tree === 'string') return tree;
  if (typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join(' ');
  if (typeof tree === 'object' && tree.props !== undefined) return textOf(tree.props.children);
  return '';
}

/** 元素树里的 className 集合(判断用的是哪套 chrome)。 */
export function classNamesOf(tree, out = []) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return out;
  if (Array.isArray(tree)) { tree.forEach((t) => classNamesOf(t, out)); return out }
  const cls = tree.props !== undefined ? tree.props.className : undefined;
  if (typeof cls === 'string') out.push(cls);
  if (tree.props !== undefined) classNamesOf(tree.props.children, out);
  return out;
}

/** 元素树里出现过的宿主元素类型(如 'div' / 'textarea' / 'input'),按出现顺序。 */
export function elementTypesOf(tree, out = []) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return out;
  if (Array.isArray(tree)) { tree.forEach((t) => elementTypesOf(t, out)); return out }
  if (typeof tree.type === 'string') out.push(tree.type);
  if (tree.props !== undefined) elementTypesOf(tree.props.children, out);
  return out;
}

/** 找到第一个指定类型的宿主元素(找不到返回 null)。 */
export function findElement(tree, type) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) {
    for (const item of tree) {
      const hit = findElement(item, type);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (tree.type === type) return tree;
  return tree.props === undefined ? null : findElement(tree.props.children, type);
}
