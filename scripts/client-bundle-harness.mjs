// scripts/client-bundle-harness.mjs —— 把客户端半部 lib/client.js 装进"最小 DSH"里跑起来
//
// 为什么值得单独一个模块:插件真正的契约在**浏览器侧** —— 它注册到哪些插槽、拿什么 props 渲染、
// 发什么请求。这些既不是纯函数也不是 host 行为,只有把入口加载起来、喂进一段假 prop/假 ctx 才能
// 钉住。0.3.48(alpha 线 DSH 0.1.6-alpha.2 去掉 SessionListState.current)与 0.3.50(设置卡从
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
//     `@deepseek-ai/dsh-client-ui-primitives` / **`@deepseek-ai/dsh-client-store`** —— 「问 DSH」面板 0.3.59
//     起靠前两者里的后两个渲染,配置表单 0.3.66 起靠 store 那一个;所以
//     `clientReactDom: false` / `clientPrimitives: false` / `clientStore: false`
//     能模拟"异常宿主取不到模块表",用来钉住**降级路径**(正文 <pre>、按钮原生 button、
//     配置区退回旧通道)而不是白屏/整条客户端不加载;
//   · slots 桩:`inject(name, factory)` **只在声明的插槽列表里回调**(复刻 DSH "插槽未被声明就不回调"
//     的语义);register 把每个 entry 的 desc 与组件留下来;
//   · 服务集桩:`services` 决定这个宿主有哪些服务(`settingsScope` 旧通道 / `configForms` 新通道),
//     `ctx.inject(deps, cb)` **只在该声明的服务都在时才回调**(与 DSH 一致),入口的静态 `inject`
//     同理 —— 缺一个服务就**不 apply**(复刻"条目 pending"),`applied` / `missingInject` 报出来。
//     `configForms` 与 `settingsScope` **刻意不做成 ctx 的属性**(只经 ctx.get 可见):未在 inject 里
//     声明的服务,属性访问在 DSH 里会抛错,而这两个服务正是不能写进 inject 的那两个。
//   · 渲染:调一次组件(可选沿"函数子组件"下钻一层层调;类组件实例化后取 render()),返回元素树;
//     另有 `propsOf(desc)`:像真壳层那样把注入面物化成 props(`hooks` 表的键 → `use<Key>` 选择器 hook);
//   · `testHooks: true` 时先设 `window.__dshcsTestHooks = true`,于是入口会额外导出 `__internals`,
//     让"纯函数单元套件"(工作区解析、全屏动作、问 DSH 面板)不必为了可测而把模块拆出去
//     (拆出去 = 又要有构建)。
//
// 用法:
//   import { loadClientBundle } from './client-bundle-harness.mjs'
//   const h = loadClientBundle({ declaredSlots: ['sidebar.right.pane.tab', 'shell.overlay'] })
//   const reg = h.registrations.find(r => r.desc.name === 'plugins.bundle.config')
//   h.render(reg.component, h.propsOf(reg, { view: 'page' }))
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
 * 形状照着 alpha 线(0.1.6-alpha.2 起,最新 0.1.7-alpha.1)的 `.d.ts` 来 —— 面板只用到这五个名字,桩也只提供这五个:
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

/** 壳层把注入面的 hooks 键派生成 props 名(`hooks.gowinToolchainForm` → `useGowinToolchainForm`)。 */
export function standardHookPropName(name) {
  return `use${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/**
 * `@deepseek-ai/dsh-client-store` 的桩:只实现入口真正用到的工厂 `createSnapshotStore(init)`
 * (真品是 zustand vanilla + immer 的引擎,这里只要 getSnapshot/subscribe/set 三件套够用)。
 */
function createFakeClientStore() {
  return {
    createSnapshotStore(init) {
      let snapshot = init;
      const listeners = new Set();
      return {
        getSnapshot: () => snapshot,
        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
        set(next) { snapshot = next; [...listeners].forEach((fn) => fn()) },
        update(mutator) { const next = { ...snapshot }; mutator(next); snapshot = next; [...listeners].forEach((fn) => fn()) },
      };
    },
  };
}

/**
 * `configForms` 服务桩(新通道)。语义照上游 `dsh-client-ui-settings` 的 `.d.ts` 与实现:
 *   · `get(entryId)` → 该条目的表单模型:`getSnapshot()`({status,writable,revision,value,base,user})、
 *     `subscribe(cb)`、**唯一写路径** `mutate(ops, revision)`、`dispose()`(另有 set/unset:入口不该用,
 *     用例会断言"没被调");
 *   · `whileServed(namespaces, register)` → 门禁:只要列出的命名空间**有一个正被服务**,
 *     `register(服务集合)` 就被调用一次并返回它的 disposer;全都不被服务时调用那个 disposer。
 *
 * @param options.servedNamespaces 初始"宿主正在服务"的命名空间集合
 * @param options.snapshot 初始表单快照(status/writable/revision/value/base/user 可覆盖)
 * @param options.applyMutate=false 让 mutate 只记账、不更新镜像(用来验"被拒时保留草稿")
 */
function createFakeConfigForms(options = {}) {
  const formListeners = new Set();
  const servedListeners = new Set();
  const calls = { get: [], mutate: [], set: [], unset: [], whileServed: [] };
  let served = new Set(options.servedNamespaces ?? []);
  const snapshot = {
    status: 'ready', writable: true, revision: 7, value: {}, base: undefined, user: {}, mode: 'host',
    ...(options.snapshot ?? {}),
  };
  const form = {
    getSnapshot: () => snapshot,
    subscribe(fn) { formListeners.add(fn); return () => { formListeners.delete(fn) } },
    dispose() { formListeners.clear() },
    async mutate(ops, revision) {
      calls.mutate.push({ ops, revision });
      if (options.applyMutate === false) return options.mutateLands !== false;
      // 复刻宿主"接受后把应答折回镜像":值层与用户层都更新,revision 前进,订阅者被通知。
      const value = { ...snapshot.value };
      const user = { ...(snapshot.user ?? {}) };
      for (const op of ops) {
        const field = Array.isArray(op.path) ? op.path[0] : undefined;
        if (op.op === 'unset') delete user[field];
        else { value[field] = op.value; user[field] = op.value }
      }
      snapshot.value = value;
      snapshot.user = user;
      snapshot.revision += 1;
      [...formListeners].forEach((fn) => fn());
      return true;
    },
    async set(field, value) { calls.set.push({ field, value }); return true },
    async unset(field) { calls.unset.push({ field }); return true },
  };
  const service = {
    get(entryId) { calls.get.push(entryId); return form },
    whileServed(namespaces, register) {
      calls.whileServed.push([...namespaces]);
      let off;
      const sync = () => {
        const watched = namespaces.some((ns) => served.has(ns));
        if (watched && off === undefined) off = register(new Set(served));
        else if (!watched && off !== undefined) { off(); off = undefined }
      };
      servedListeners.add(sync);
      sync();
      return () => { servedListeners.delete(sync); if (off !== undefined) { off(); off = undefined } };
    },
  };
  return {
    service,
    form,
    calls,
    snapshot,
    /** 测试用:改"宿主正在服务哪些命名空间"并通知 whileServed(门禁用例)。 */
    setServed(namespaces) { served = new Set(namespaces); [...servedListeners].forEach((sync) => sync()) },
    servedNamespaces: () => new Set(served),
  };
}

/**
 * 加载产物并 apply 一次。
 * @param options.declaredSlots 已声明的插槽名(不在此列 ⇒ inject 不回调,与 DSH 行为一致)
 * @param options.status `/api/code-server/status` 的返回体
 * @param options.scopeSnapshot 旧通道:`settingsScope.bind(...).getSnapshot()` 的返回体
 * @param options.settingsScope=false 拿掉旧通道(模拟 0.1.7-alpha.1)
 * @param options.configForms=true 装上**新通道**(configForms + @deepseek-ai/dsh-client-store)
 * @param options.configServed=false 让新通道的门禁先不通过(宿主还没在服务这个条目),之后用
 *   `h.setConfigServed(true)` 放行 —— 用来钉"只在 whileServed 之后注册"
 * @param options.clientStore=false 让模块表里没有 `@deepseek-ai/dsh-client-store`(异常宿主)
 */
export function loadClientBundle(options = {}) {
  const declared = new Set(options.declaredSlots ?? []);
  const statusPayload = options.status ?? DEFAULT_STATUS;
  const scopeSnapshot = options.scopeSnapshot ?? { status: 'ready', value: {}, user: {}, writable: true };
  const forms = options.configForms === true
    ? createFakeConfigForms({
      servedNamespaces: options.configServed === false ? [] : ['code-server'],
      snapshot: options.formSnapshot,
      applyMutate: options.applyMutate,
      mutateLands: options.mutateLands,
    })
    : null;
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
  const clientStore = createFakeClientStore();
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
    if (name === '@deepseek-ai/dsh-client-store') {
      if (options.clientStore === false) {
        throw new Error('client-modules: require("@deepseek-ai/dsh-client-store") missed the module table(测试:模拟异常宿主)');
      }
      return clientStore;
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
  /** 这位"宿主"有哪些服务(名字 → 服务对象)。 */
  const services = {
    slots,
    sidebarRightTabs: { register: () => () => {}, guide: () => [], entries: () => [], subscribe: () => () => {} },
    sidebarRight: { bind: () => {}, openTab: () => {}, closeIn: () => {}, isExpanded: () => false, toggleExpanded: () => {} },
  };
  if (options.settingsScope !== false) {
    services.settingsScope = {
      bind: () => ({
        getSnapshot: () => scopeSnapshot,
        subscribe: () => () => {},
        set: async () => {}, unset: async () => {},
      }),
    };
  }
  if (forms !== null) services.configForms = forms.service;
  const ctx = {
    get: (name) => services[name],
    slots,
    sidebarRightTabs: services.sidebarRightTabs,
    sidebarRight: services.sidebarRight,
    effect: (fn) => { const out = fn(); return typeof out === 'function' ? out : () => {} },
  };
  // 两个**通道**服务永远不做成属性(cordis 只把"声明在 inject 里的服务"暴露成属性):
  // 它们不能进 inject —— 写进去会让另一条线上的条目 pending —— 所以只能经 `ctx.get` 拿。
  // 这里让属性访问当场抛,写法一错就在测试里炸,而不是在用户机器上静默取不到/整条 UI 消失。
  for (const name of ['configForms', 'settingsScope']) {
    Object.defineProperty(ctx, name, {
      get() { throw new Error(`${name} 只能经 ctx.get 拿(它不能进 inject:会让另一条 DSH 上的条目 pending)`) },
    });
  }
  /** `ctx.inject(deps, cb)`:与 DSH 一致,**声明的服务都在**才回调(缺一个就永远 pending)。 */
  const injectWaits = [];
  ctx.inject = (deps, cb) => {
    const missing = deps.filter((name) => services[name] === undefined);
    if (missing.length > 0) { injectWaits.push({ deps, missing }); return () => {} }
    const out = cb(ctx);
    return typeof out === 'function' ? out : () => {};
  };
  // 入口的静态 inject 决定"这条目会不会激活":缺一个服务就不 apply(复刻 pending),并记下来。
  const missingInject = mod.inject.filter((name) => services[name] === undefined);
  const applied = missingInject.length === 0;
  if (applied) mod.apply(ctx);

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

  /** 复刻壳层"注入面 → props"的物化:面里的 `hooks` 表按 `use<Key>` 派生成选择器 hook,
   *  其余键原样成为 props(`view` 这类由页面给的用 `extra` 传)。
   *  参数可以是 `registrations` 里那一项,也可以是它的 `.desc`(两种都常见)。 */
  function propsOf(registration, extra = {}) {
    const desc = registration !== null && registration !== undefined && registration.desc !== undefined
      ? registration.desc : registration;
    const face = desc !== null && desc !== undefined && typeof desc.inject === 'function' ? (desc.inject() ?? {}) : {};
    const out = { ...extra };
    for (const [key, value] of Object.entries(face)) {
      if (key === 'hooks') {
        for (const [name, source] of Object.entries(value ?? {})) {
          out[standardHookPropName(name)] = (selector) => fake.React.useSyncExternalStore(
            (cb) => source.subscribe(cb),
            () => (typeof selector === 'function' ? selector(source.getSnapshot()) : source.getSnapshot()),
          );
        }
      } else if (key === 'keyedHooks') {
        // 本插件不用 keyed 源(照实跳过,免得"用了不存在的形状"在测试里查不出来)
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  return {
    registrations,
    injects,
    calls,
    render,
    propsOf,
    statusPayload,
    scopeSnapshot,
    /** 这位"宿主"提供的服务名集合(用例据此断言入口的静态 inject 能被满足)。 */
    services: new Set(Object.keys(services)),
    /** 喂给入口的那个 ctx(用例可断言"未声明的服务属性访问会抛"这类契约)。 */
    ctx,
    /** 入口静态 inject 里缺的服务(非空 = 条目永远 pending,DSH 的 "N entries did not activate")。 */
    missingInject,
    /** `ctx.inject(deps, cb)` 里因为服务缺失而**没**回调的记录。 */
    injectWaits,
    /** 条目是否真的 apply 了(缺服务 = false,复刻 pending)。 */
    applied,
    /** 新通道的服务桩句柄(`configForms: true` 时非 null):`{calls, snapshot, setServed, ...}`。 */
    forms,
    /** 测试用:改"宿主正在服务哪些命名空间"并通知 whileServed 门禁。 */
    setConfigServed: (namespaces) => { if (forms !== null) forms.setServed(namespaces) },
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
