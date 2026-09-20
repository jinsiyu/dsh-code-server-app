// scripts/client-bundle-harness.mjs —— 把客户端半部 lib/client.js 装进"最小 DSH"里跑起来
//
// 为什么值得单独一个模块:插件真正的契约在**浏览器侧** —— 它注册到哪些插槽、拿什么 props 渲染、
// 发什么请求。这些既不是纯函数也不是 host 行为,只有把入口加载起来、喂进一段假 prop/假 ctx 才能
// 钉住。0.3.48(DSH 0.1.6-alpha.2 去掉 SessionListState.current)与 0.3.50(设置卡从
// settings.plugin.item 搬到插件页 plugins.bundle.config)两次都是"本机看不出、一升级就静默失效",
// 所以回归必须落在这一层。
//
// **0.3.58 起没有"构建产物"了**:lib/client.js 就是手写源码(见它的文件头)。因此这里不再有
// "产物比源码旧就 SKIP"那套新鲜度检查 —— 加载失败就是真失败。
//
// 提供的能力(刻意保持最小、够用即止):
//   · window.__ModuleLoader__ / document / fetch / setInterval 桩;
//   · 极简 react 桩:hook 按调用次数记账,effect **立即执行**(被测的正是 effect 里的请求与 iframe src);
//     另有真的 Component(类组件/错误边界)+ Fragment;
//   · 模块表桩:`react` / `react/jsx-runtime` / `react-dom/client` /
//     `@deepseek-ai/dsh-client-ui-primitives` —— 「问 DSH」面板 0.3.59 起靠后两个渲染,所以
//     `clientReactDom: false` / `clientPrimitives: false` 能模拟"异常宿主取不到种子词",
//     用来钉住**降级路径**(正文 <pre>、按钮原生 button)而不是白屏;
//   · slots 桩:`inject(name, factory)` **只在声明的插槽列表里回调**(复刻 DSH "插槽未被声明就不回调"
//     的语义);register 把每个 entry 的 desc 与组件留下来;
//   · 渲染:调一次组件(可选沿"函数子组件"下钻一层层调;类组件实例化后取 render()),返回元素树;
//   · `testHooks: true` 时先设 `window.__dshcsTestHooks = true`,于是入口会额外导出 `__internals`,
//     让"纯函数单元套件"(工作区解析、全屏动作、问 DSH 面板)不必为了可测而把模块拆出去
//     (拆出去 = 又要有构建)。
//
// 用法:
//   import { loadClientBundle } from './client-bundle-harness.mjs'
//   const h = loadClientBundle({ declaredSlots: ['sidebar.right.pane.tab', 'shell.overlay'] })
//   const reg = h.registrations.find(r => r.desc.name === 'plugins.bundle.config')
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const pkgRoot = join(here, '..');

/** 客户端入口的路径(手写源码;DSH 通过 package.json 的 exports["./client"] 加载同一个文件)。 */
export const CLIENT_ENTRY = join(pkgRoot, 'lib', 'client.js');

/** 极简 react:hook 按调用次数记账,单次渲染即可;effect 立即执行。 */
function createFakeReact() {
  let cells = [];
  let index = 0;
  /** React 只在类组件里提供错误边界 ⇒ 桩里也要有一个真的 Component。 */
  class Component {
    constructor(props) { this.props = props === undefined || props === null ? {} : props; this.state = {} }

    setState(patch) {
      const next = typeof patch === 'function' ? patch(this.state) : patch;
      this.state = { ...this.state, ...(next === undefined || next === null ? {} : next) };
    }
  }
  return {
    reset() { cells = []; index = 0 },
    React: {
      Component,
      Fragment: 'Fragment',
      createElement(type, props, ...children) {
        const next = { ...(props === null || props === undefined ? {} : props) };
        if (children.length === 1) next.children = children[0];
        else if (children.length > 1) next.children = children;
        return { type, props: next };
      },
      memo(component) { return component },
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
      useMemo(fn) { index += 1; return fn() },
      useCallback(fn) { index += 1; return fn },
      useSyncExternalStore(subscribe, getSnapshot) { index += 1; return getSnapshot(); },
    },
  };
}

/**
 * 官方 UI primitives 的桩(模块表种子词 `@deepseek-ai/dsh-client-ui-primitives`)。
 *
 * 形状照着 0.1.6-alpha.2 的 `.d.ts` 来 —— 面板只用到这五个名字,桩也只提供这五个:
 * 多给会让"面板用了不存在的导出"这种错误在测试里查不出来。
 *
 * **`MarkdownText` 刻意做成 `React.memo` 对象而不是函数**:官方就是
 * `export declare const MarkdownText: MemoExoticComponent<…>`,值是一个
 * `{$$typeof: Symbol(react.memo), type}` 对象。(0.3.59 实测踩过:面板用 `typeof === 'function'`
 * 判可用性,于是实机正文整个退成 `<pre>`,而桩当时是函数 ⇒ 单测全绿。)
 */
function createFakePrimitives(React) {
  return {
    MarkdownText: {
      $$typeof: Symbol.for('react.memo'),
      compare: null,
      type: function MarkdownTextInner({ text, streaming, labels }) {
        return React.createElement('div', {
          className: 'stub-markdown', 'data-streaming': streaming === true, 'data-copy-label': labels.code.copyLabel,
        }, text);
      },
    },
    DisclosureRow(props) {
      return React.createElement('div', {
        className: 'stub-disclosure', 'data-title': props.title, 'data-open': props.open === true,
        onClick: props.onToggle,
      }, props.collapsedContent, props.children);
    },
    Button(props) {
      return React.createElement('button', {
        className: 'stub-button', 'data-variant': props.variant, disabled: props.disabled, onClick: props.onClick,
      }, props.children);
    },
    IconThinkOutline14(props) { return React.createElement('i', { className: 'stub-icon-think', 'data-size': props.size }) },
    IconContextInjectionOutline16(props) { return React.createElement('i', { className: 'stub-icon-context', 'data-size': props.size }) },
  };
}

function createFakeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {}, dataset: {}, attributes: {}, children: [], className: '', src: '', textContent: '',
    listeners: {},
    setAttribute(name, value) { el.attributes[name] = String(value) },
    removeAttribute(name) { delete el.attributes[name] },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(el.attributes, name) },
    appendChild(child) { el.children.push(child); return child },
    removeChild(child) { el.children = el.children.filter((c) => c !== child); return child },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn) },
    removeEventListener(type, fn) { const list = el.listeners[type]; if (list !== undefined) el.listeners[type] = list.filter((f) => f !== fn) },
    /** 测试用:手动触发已登记的事件(如头部 pointerdown、按钮 click)。 */
    dispatch(type, event) { (el.listeners[type] || []).forEach((fn) => fn(event === undefined ? {} : event)) },
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
  // 入口的测试钩子:只有显式要的时候才设,确保"未设标志时没有 __internals"也能被断言到。
  if (options.testHooks === true) globalThis.window.__dshcsTestHooks = true;
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
  const bundle = readFileSync(CLIENT_ENTRY, 'utf8');
  new Function('window', 'document', 'fetch', 'setTimeout', 'setInterval', 'clearInterval', 'console', bundle)(
    globalThis.window, globalThis.document, globalThis.fetch,
    (fn) => { void fn; return 0 }, () => 0, () => {}, console,
  );
  assert.equal(loaded.length, 1, '入口应恰好调用一次 __ModuleLoader__.load');
  const entry = loaded[0];
  assert.equal(entry.id, 'dsh-code-server-app');
  /** 面板挂载时建过的 React 根(断言"挂到哪、渲染了什么")。 */
  const roots = [];
  const primitives = createFakePrimitives(fake.React);
  const mod = entry.factory((name) => {
    if (name === 'react') return fake.React;
    if (name === 'react/jsx-runtime') return { jsx: fake.React.createElement, jsxs: fake.React.createElement };
    if (name === 'react-dom/client') {
      if (options.clientReactDom === false) {
        throw new Error('client-modules: require("react-dom/client") missed the module table(测试:模拟异常宿主)');
      }
      return {
        createRoot(container) {
          const root = {
            container,
            rendered: null,
            render(element) { root.rendered = element },
            unmount() { root.rendered = null },
          };
          roots.push(root);
          return root;
        },
      };
    }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      if (options.clientPrimitives === false) {
        throw new Error('client-modules: require("@deepseek-ai/dsh-client-ui-primitives") missed the module table(测试:模拟异常宿主)');
      }
      return primitives;
    }
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
   *  类组件(面板的错误边界)实例化后取 render();effect 立即执行(app 里真正的请求/iframe src
   *  就发生在 effect 里)。 */
  function renderTree(node, depth) {
    if (node === null || node === undefined || depth > 8) return node;
    if (typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((child) => renderTree(child, depth));
    let type = node.type;
    // React.memo / forwardRef / lazy:对象形态的组件类型(官方 MarkdownText 就是 memo)⇒ 取它包着的那个。
    if (type !== null && typeof type === 'object' && type.$$typeof !== undefined) {
      type = type.type !== undefined ? type.type : type.render;
      if (typeof type !== 'function') return node;
      return renderTree({ type, props: node.props }, depth + 1);
    }
    if (typeof type === 'function') {
      const props = node.props === undefined ? {} : node.props;
      // 类组件不能当函数调(`Class constructor ... cannot be invoked without 'new'`)。
      if (/^\s*class[\s{]/.test(Function.prototype.toString.call(type))) {
        const instance = new type(props);
        instance.props = props;
        return renderTree(instance.render(), depth + 1);
      }
      return renderTree(type(props), depth + 1);
    }
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
    /** 面板挂载建过的 React 根(`{container, rendered}`);`rendered` 就是面板元素树。 */
    roots,
    /** 官方 UI primitives 的桩(面板用它渲染 MarkdownText / DisclosureRow / Button)。 */
    primitives,
    /** 入口模块的导出(未开 testHooks 时没有 __internals)。 */
    exports: mod,
    /**
     * 入口导出的内部函数表(只有 `testHooks: true` 时存在)。
     * 两个"纯函数单元套件"用它,避免为了可测把模块拆出去(拆出去就意味着又要有构建)。
     */
    internals: mod.__internals ?? null,
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
