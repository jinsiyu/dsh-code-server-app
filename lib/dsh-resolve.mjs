/**
 * lib/dsh-resolve.mjs — 从 DSH 部署里解析 DSH 自己的包(0.3.0)。
 *
 * 插件**不**把 `@deepseek-ai/*` 写进 `dependencies`:它们是 DSH 的一部分,版本交给部署决定
 * (与 schemastery 在 `lib/index.js` 顶部的同一决策)。常规 import 失败时按三个位置回退:
 *   1. 常规 ESM 解析(开发期 profile 的 node_modules 里通常有);
 *   2. npm 全局布局的 DSH 部署副本(`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`);
 *   3. `$DSH_HOME/profiles/node_modules`(profile 层级的安装位置)。
 *
 * 注意解析出来的模块与 DSH host 用的是**同一份**(同一路径的 require 缓存),所以
 * `createUserMessage` 出来的对象能直接喂给 `agent.followup()`。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

/** 按 2、3 两个布局给出 DSH 的入口 package.json(存在的才返回)。 */
function dshEntryCandidates() {
  const candidates = [];
  const appData = process.env.APPDATA;
  if (typeof appData === 'string' && appData !== '') {
    candidates.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  }
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home !== '') {
    candidates.push(path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  }
  return candidates;
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
