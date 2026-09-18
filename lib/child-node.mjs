/**
 * lib/child-node.mjs — 给「VS Code server 子进程」挑一个**真 Node**(0.3.53)。
 *
 * 为什么必须挑:DSH Desktop 的宿主进程是用 **Electron 的 Node 模式**跑的
 * (`ELECTRON_RUN_AS_NODE=1`,`process.execPath` = Electron 二进制;见 harness 的
 * `apps/desktop/src/node-environment.ts` 与 `host-process.ts`)。插件 spawn launcher 时若照旧用
 * `process.execPath`,VS Code 的 server-main 会在启动时注册自己的 ESM 解析钩子,而那段钩子
 * **只在 Electron / ELECTRON_RUN_AS_NODE 下生效**:
 *
 *   if (!process.env.ELECTRON_RUN_AS_NODE && !process.versions.electron) return;
 *   ...
 *   const L = <默认解析结果>;
 *   if (!L.startsWith(<应用根>)) {  // 树外 → 去 node_modules.asar 找,找不到就抛
 *     throw new Error(`Cannot find package '${name}' within the application resources`);
 *   }
 *
 * 本插件的原生包是**树外**的 pnpm 目录(`<profile>/node_modules/.pnpm/…`),于是启动路径上的
 * `@vscode/spdlog` / `@vscode/deviceid` / `@vscode/windows-registry` 三个 ESM import 被拒,
 * launcher 打 `FATAL 加载 VS Code server 失败` 后退出 ⇒ 面板显示「code-server 意外退出(exit 2)」。
 * 2026-09-18 实测(同一棵树、同一份 launcher):
 *   · Electron(Node 模式)→ 必炸(首行 `Cannot find package '@vscode/spdlog' within the application resources`);
 *   · 桌面版自带的 `resources/runtime/primary-runtime/dependencies/node/bin/node.exe`(v24.21.0)→
 *     一次启动成功(`Extension host agent started` + `dshcs-ready`),stderr 全空。
 *
 * 所以这里只做一件事:宿主是 Electron 时**找一个真 Node** 给子进程用,并从子进程环境里删掉
 * `ELECTRON_RUN_AS_NODE`(留着它,真 Node 也会被判成 Electron,钩子照样生效)。普通 node 宿主
 * (web / CLI)原样返回 `process.execPath`,行为一字不变。找不到真 Node 时退回 Electron(与旧行为一致)
 * 并由调用方**明确告警**,不再让人对着 exit 2 猜。
 *
 * 试过但**不能用**的兜底(2026-09-18 实测,别再走一遍):
 *   · `VSCODE_DEV=1`:钩子确实被绕过(`s = process.env.VSCODE_DEV ? undefined : …`),但 VS Code 同时切到
 *     dev 引导路径,转头就报 `Cannot find module '<树>/lib/vscode/out/bootstrap-import.js'` —— 精简树里没这文件。
 *   · 往树内补 junction:Node 的 ESM 解析会 **realpath**(实测 `import.meta.resolve('@vscode/spdlog')` 返回的是
 *     pnpm store 路径),所以链接建在树里也仍旧"落在应用根之外",钩子照样拒。
 *
 * 纯路径/环境判断,不碰进程 → 可离线单测(scripts/test-child-node.mjs)。
 */

import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** 宿主是不是 Electron(含 Node 模式的两个判据)。 */
export function isElectronHost(versions = process.versions, env = process.env) {
  const flag = env.ELECTRON_RUN_AS_NODE;
  const flagged = typeof flag === 'string' && flag !== '' && flag !== '0' && flag !== 'false';
  return Boolean(versions !== null && versions !== undefined && versions.electron) || flagged;
}

/** 真 Node 的文件名(平台惯例)。 */
export function nodeBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'node.exe' : 'node';
}

/**
 * 真 Node 候选表(按优先级)。每条都带 `source` 便于日志/断言。
 * @param options.execPath - 宿主可执行文件(通常是 Electron)。
 * @param options.resourcesPath - Electron 的 `process.resourcesPath`(可能 undefined)。
 * @param options.env - 环境变量(PATH / DSH_DESKTOP_NODE_EXECUTABLE)。
 */
export function childNodeCandidates(options = {}) {
  const execPath = typeof options.execPath === 'string' ? options.execPath : process.execPath;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const resourcesPath = typeof options.resourcesPath === 'string' ? options.resourcesPath : undefined;
  const bin = nodeBinaryName(platform);
  // 路径风格跟着 platform 走(而不是跟着"跑测试的这台机器"),Linux/macOS 形态才测得到
  const paths = platform === 'win32' ? win32 : posix;
  const join = paths.join;
  const out = [];
  const push = (source, path) => {
    if (typeof path !== 'string' || path === '' || path === execPath) return;
    if (out.some((entry) => entry.path === path)) return;
    out.push({ source, path });
  };

  if (resourcesPath !== undefined) {
    // ① 桌面版当前布局:主运行时自带的 Node(实测 v24.21.0,唯一被验证可用的那条)
    push('app-primary-runtime-node', join(resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', bin));
    // ② 旧布局(0.1.5 及更早):应用自带一份 node
    push('app-runtime-node', join(resourcesPath, 'runtime', 'node', bin));
    // ③ 通用布局
    push('app-resources-node', join(resourcesPath, 'node', bin));
  }
  // ④ resourcesPath 拿不到时,从可执行文件旁边推
  push('exec-side-runtime-node', join(paths.dirname(execPath), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', bin));
  push('exec-side-node', join(paths.dirname(execPath), 'resources', 'runtime', 'node', bin));

  // ⑤ 上游可能直接给了 node 的路径 —— 只有当它**看起来就是 node 二进制**时才认
  //    (实测 `DSH_DESKTOP_NODE_EXECUTABLE` 指向的是 Electron 自身,不能用)
  const hinted = env.DSH_DESKTOP_NODE_EXECUTABLE;
  if (typeof hinted === 'string' && hinted !== '' && /^node(\.exe)?$/i.test(hinted.replace(/\\/g, '/').split('/').pop() ?? '')) {
    push('env-dsh-desktop-node', hinted);
  }

  // ⑥ PATH 上的真 Node(跳过应用自己的 resources —— 那里的 `node`/`node.cmd` 是"再调 Electron"的 shim)
  const pathValue = typeof env.PATH === 'string' ? env.PATH : (typeof env.Path === 'string' ? env.Path : '');
  for (const dir of pathValue.split(paths.delimiter)) {
    if (dir === '') continue;
    if (resourcesPath !== undefined && dir.toLowerCase().startsWith(resourcesPath.toLowerCase())) continue;
    push('path-node', join(dir, bin));
  }
  return out;
}

/**
 * 给子进程挑解释器。
 * @returns {{command:string, electronHost:boolean, swapped:boolean, source:string}}
 *   · 非 Electron 宿主:`{ command: process.execPath, swapped: false, source: 'host-node' }`(行为不变);
 *   · Electron 宿主且找到真 Node:`swapped: true`(调用方须用 childNodeEnv 剥掉 ELECTRON_RUN_AS_NODE);
 *   · Electron 宿主但一个候选都不在:`source: 'electron-fallback'`(与旧行为一致,调用方应告警)。
 */
export function resolveChildNode(options = {}) {
  const execPath = typeof options.execPath === 'string' ? options.execPath : process.execPath;
  const versions = options.versions ?? process.versions;
  const env = options.env ?? process.env;
  const exists = typeof options.exists === 'function' ? options.exists : existsSync;
  const electronHost = isElectronHost(versions, env);
  if (!electronHost) return { command: execPath, electronHost: false, swapped: false, source: 'host-node' };
  for (const candidate of childNodeCandidates({ execPath, resourcesPath: options.resourcesPath ?? process.resourcesPath, env, platform: options.platform })) {
    try {
      if (exists(candidate.path)) {
        return { command: candidate.path, electronHost: true, swapped: true, source: candidate.source };
      }
    } catch { /* 下一个候选 */ }
  }
  return { command: execPath, electronHost: true, swapped: false, source: 'electron-fallback' };
}

/**
 * 子进程环境:用真 Node 时**必须**删掉 `ELECTRON_RUN_AS_NODE`,否则 VS Code 的 asar 解析钩子照样生效
 * (钩子的判据是"环境变量或 versions.electron 二者之一")。退回 Electron 时反而要留着它,否则
 * Electron 会当 GUI 应用启动。
 */
export function childNodeEnv(resolved, env = process.env) {
  const next = { ...env };
  if (resolved !== null && resolved !== undefined && resolved.swapped === true) delete next.ELECTRON_RUN_AS_NODE;
  return next;
}
