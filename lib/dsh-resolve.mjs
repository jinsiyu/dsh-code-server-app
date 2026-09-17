/**
 * lib/dsh-resolve.mjs — 从 DSH 部署里解析 DSH 自己的包(0.3.0;0.3.49 起位置表按平台铺开)。
 *
 * 插件**不**把 `@deepseek-ai/*` 写进 `dependencies`:它们是 DSH 的一部分,版本交给部署决定
 * (与 schemastery 在 `lib/index.js` 顶部的同一决策)。常规 import 失败时按下面的位置表回退,
 * 找到第一个**真的存在** `@deepseek-ai/dsh/package.json` 的目录,用它建一个 require。
 *
 * 位置表分三类(顺序即优先级,不猜、不静默降级 —— 全都不在就是解析失败):
 *   ① **正在跑的这份部署**:插件的宿主进程就是 CLI 拉起来的,`process.argv[1]` 附近通常能直接
 *      `require.resolve('@deepseek-ai/dsh/package.json')`(desktop 的 host 子进程、SDK 形态都吃这条);
 *   ② **各平台的「全局装」布局**:Windows `%APPDATA%\npm`、`npm --prefix`(`~/.npm-global`,
 *      release.yml 的 Linux 安装冒烟腿用的就是这个)、pnpm global、nvm、系统 `/usr/local|/usr`;
 *   ③ **`$DSH_HOME` 的 profile 层**:DSH 每次 boot 会在 `profiles/node_modules` heal 出 junction,
 *      某些形态下某个 profile 自己那份也在。
 *
 * 为什么位置表必须铺开(0.3.48 → 0.3.49 的实测):只认 ① ②里的 Windows 一条与 ③ 时,
 * 在 **Linux CI** 上(CLI 装到 `~/.npm-global`)整条链都落空 ⇒ 插件解析不到 schemastery ⇒
 * 安装冒烟 ④「已安装的 lib/index.js 可加载」直接抛错;而真实 Linux 用户(nvm / 自定义 prefix /
 * pnpm global)是同一类布局,只是本机遇不到而已。
 *
 * 注意解析出来的模块与 DSH host 用的是**同一份**(同一路径的 require 缓存),所以
 * `createUserMessage` 出来的对象能直接喂给 `agent.followup()`。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

/** 部署入口在某个 node_modules 下的尾巴。 */
const DSH_ENTRY_SEGMENTS = ['@deepseek-ai', 'dsh', 'package.json'];

/** 目录里的直接子目录(含符号链接/junction;只扫一层,数量封顶;读不到就是空表)。 */
function childDirs(dir, limit = 64) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .slice(0, limit)
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** 家目录:环境变量优先(测试/CI 可覆盖),再退 os.homedir()。 */
function homeDir() {
  const fromEnv = process.env.HOME ?? process.env.USERPROFILE;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  try {
    return os.homedir();
  } catch {
    return '';
  }
}

/**
 * 部署位置表(顺序即优先级;调用方逐个试"文件在不在")。
 * 导出仅为单测:正常用法见 `dshEntry()` / `dshRequire()`。
 */
export function dshEntryCandidates() {
  const out = [];
  /** 把一个 node_modules 目录拼成部署入口候选。 */
  const entryOf = (nodeModulesDir) => {
    if (typeof nodeModulesDir !== 'string' || nodeModulesDir === '') return;
    out.push(path.join(nodeModulesDir, ...DSH_ENTRY_SEGMENTS));
  };

  // ① 正在跑的这份部署:从 CLI 入口(argv[1])与 node 二进制(execPath)各自向上解析一次。
  for (const base of [process.argv[1], process.execPath]) {
    if (typeof base !== 'string' || base === '') continue;
    try {
      const resolved = createRequire(path.resolve(base)).resolve('@deepseek-ai/dsh/package.json');
      entryOf(path.dirname(resolved));
    } catch {
      // 这个入口附近没有部署副本 → 下一个候选
    }
  }

  // ② 各平台的「全局装」布局。
  const home = homeDir();
  const appData = process.env.APPDATA;
  if (typeof appData === 'string' && appData !== '') {
    // Windows 用户级 npm 全局(本机日常形态;保持在最前面,行为不变)
    entryOf(path.join(appData, 'npm', 'node_modules'));
  }
  if (home !== '') {
    // npm --prefix <用户目录>(release.yml 的 Linux 安装冒烟腿;也是常见的"免 sudo 全局装")
    entryOf(path.join(home, '.npm-global', 'lib', 'node_modules'));
  }
  const pnpmHome = process.env.PNPM_HOME;
  if (typeof pnpmHome === 'string' && pnpmHome !== '') {
    entryOf(path.join(pnpmHome, 'node_modules'));
    // pnpm 的全局包在 <PNPM_HOME>/global/<大版本>/node_modules
    for (const dir of childDirs(path.join(pnpmHome, 'global'))) entryOf(path.join(dir, 'node_modules'));
  }
  if (home !== '') {
    // pnpm global 的默认根(未设 PNPM_HOME 时)
    for (const dir of childDirs(path.join(home, '.local', 'share', 'pnpm', 'global'))) {
      entryOf(path.join(dir, 'node_modules'));
    }
  }
  const nvmDir = process.env.NVM_DIR ?? (home !== '' ? path.join(home, '.nvm') : '');
  if (nvmDir !== '') {
    for (const dir of childDirs(path.join(nvmDir, 'versions', 'node'))) {
      entryOf(path.join(dir, 'lib', 'node_modules'));
    }
  }
  // 系统级(macOS / Linux 发行版包;Windows 上是无意义路径,existsSync 直接 false)
  entryOf('/usr/local/lib/node_modules');
  entryOf('/usr/lib/node_modules');

  // ③ $DSH_HOME 的 profile 层。
  const dshHome = process.env.DSH_HOME;
  if (typeof dshHome === 'string' && dshHome !== '') {
    const profiles = path.join(dshHome, 'profiles');
    entryOf(path.join(profiles, 'node_modules'));
    for (const dir of childDirs(profiles)) {
      if (path.basename(dir) === 'node_modules') continue;
      entryOf(path.join(dir, 'node_modules'));
    }
  }
  return out;
}

/** 第一个存在的 DSH 入口(诊断用;不存在返回 null)。 */
export function dshEntry() {
  for (const candidate of dshEntryCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 下一个候选
    }
  }
  return null;
}

/** DSH 入口处的 require(用于 CJS 形态的包);都不可用返回 null。 */
export function dshRequire() {
  const entry = dshEntry();
  if (entry === null) return null;
  try {
    return createRequire(entry);
  } catch {
    return null;
  }
}

/**
 * 解析一个 DSH 包(ESM import 优先,再回退 CJS require)。
 * @param {string} name 包名,如 `@deepseek-ai/dsh-tools`
 * @returns {Promise<object|null>} 模块命名空间,解析不到返回 null
 */
export async function loadDshModule(name) {
  try {
    // 变量说明符:让打包器/静态检查不要把这行当成硬依赖。
    const specifier = name;
    const mod = await import(specifier);
    if (mod !== null && mod !== undefined) return mod;
  } catch {
    // 回退到部署副本
  }
  const req = dshRequire();
  if (req !== null) {
    try {
      const mod = req(name);
      if (mod !== null && mod !== undefined) return mod;
    } catch {
      // 解析失败
    }
  }
  return null;
}

/**
 * 解析一个 DSH 包并取其中一个具名导出。
 * @param {string} name 包名
 * @param {string} exportName 导出名
 */
export async function loadDshExport(name, exportName) {
  const mod = await loadDshModule(name);
  if (mod === null) return null;
  const value = mod[exportName];
  return value === undefined ? null : value;
}
