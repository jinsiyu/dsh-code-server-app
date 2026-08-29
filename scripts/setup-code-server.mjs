// scripts/setup-code-server.mjs — 方案 D:插件包内 npm 自装 code-server(Windows 兼容)。
//
// 背景:code-server 的官方 postinstall 是 `sh ./postinstall.sh`(依赖 bash/symlink),
// Windows 无 sh 会直接失败;pnpm 的 build-scripts 许可只认宿主根 pnpm-workspace.yaml,
// 依赖包声明无效。因此把 code-server 从 dependencies 移除,改由本脚本在插件包
// postinstall 内用 **npm** 安装:
//   - npm 读取包内 package.json 的 allowScripts(code-server:false 跳过 sh;argon2/unrs
//     true 构建 native)——无需 --ignore-scripts,无需改宿主配置,零报错;
//   - 安装落在 **包内 node_modules**(--prefix 钉死),不写全局、不动 profile 顶层。
//
// 幂等:code-server 已实例化(entry + VS Code 内部依赖 + argon2 native 均在)则跳过;
// pnpm 重装插件后会重跑 postinstall → 自动重新自装(自愈)。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // .../dsh-code-server/scripts
const pkgRoot = join(here, '..'); // <profile>\node_modules\dsh-code-server

// 不锁定 code-server 版本:安装时总是取 npm 最新版(latest)。
// 可用环境变量 DSHCS_CODE_SERVER_VERSION 显式锁版本(如 "4.134.0"),缺省为空 = latest。

function run(cmd, args, cwd) {
  const useShell = process.platform === 'win32';
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: useShell });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${res.status})`);
}

function npm(cmdArgs, cwd) {
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', cmdArgs, cwd);
}

/** 查询 npm 最新 code-server 版本;失败(离线/网络/权限)返回 null。
 *  优先直连 registry JSON API(子进程 Node ESM,无 npm 缓存写);失败再试 npm view。 */
function latestCodeServerVersion() {
  try {
    const code = "const r=await fetch('https://registry.npmjs.org/code-server/latest');const j=await r.json();process.stdout.write(j&&j.version||'')";
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    const v = String(res.stdout || '').trim();
    if (v !== '' && /^\d+\./.test(v)) return v;
  } catch { /* fall through */ }
  try {
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const res = spawnSync(npmBin, ['view', 'code-server', 'version'], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (res.status === 0) {
      const v = String(res.stdout || '').trim();
      if (v !== '' && /^\d+\./.test(v)) return v;
    }
  } catch { /* fall through */ }
  return null;
}

/** 待安装的版本:DSHCS_CODE_SERVER_VERSION 优先(显式锁定),否则 latest 查询,再否则 latest 安装。 */
function desiredVersion() {
  const locked = process.env.DSHCS_CODE_SERVER_VERSION;
  if (typeof locked === 'string' && locked.trim() !== '') return locked.trim();
  return latestCodeServerVersion(); // null → npm install code-server(不带版本)=latest
}

/** 已安装版本(读 cs/package.json);读取失败返回 null。 */
function installedVersion(cs) {
  try {
    const pkg = JSON.parse(readFileSync(join(cs, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function ensureNpmDeps(dir) {
  if (!existsSync(join(dir, 'package.json'))) return;
  // --omit=dev:只装生产依赖(native 模块在依赖 postinstall 内建)
  npm(['install', '--omit=dev', '--no-audit', '--no-fund'], dir);
}

/** 专用安装根:<profile>\.code-server-app(如 C:\Users\User\.dsh\profiles\web\.code-server-app),
 *  与 profile 依赖树隔离(避免 npm 在 profile 根解析其他插件依赖触发 ERESOLVE)。
 *  最终 code-server 位于:<profile>\.code-server-app\node_modules\code-server */
const APP_DIR_NAME = '.code-server-app';

function profileRootOf() {
  // pkgRoot = <profile>\node_modules\dsh-code-server;向上两级 = <profile> 根;
  // 上层存在 node_modules + package.json 视为 profile 布局
  const profileRoot = join(pkgRoot, '..', '..');
  const isProfileLayout = existsSync(join(profileRoot, 'node_modules')) && existsSync(join(profileRoot, 'package.json'));
  return isProfileLayout ? profileRoot : null;
}

function findCodeServer() {
  // 布局候选(与安装目标同顺序):
  //   1. profile 专用目录:profileRoot\code-server-app\node_modules\code-server
  //   2. 包内:pkgRoot/node_modules/code-server(开发期 link:/独立目录)
  const profileRoot = profileRootOf();
  const cands = [];
  if (profileRoot !== null) {
    cands.push(join(profileRoot, APP_DIR_NAME, 'node_modules', 'code-server'));
  }
  cands.push(join(pkgRoot, 'node_modules', 'code-server'));
  for (const cand of cands) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

function isComplete(cs) {
  return existsSync(join(cs, 'out', 'node', 'entry.js')) &&
    existsSync(join(cs, 'lib', 'vscode', 'node_modules', '@vscode', 'ripgrep')) &&
    (existsSync(join(cs, 'node_modules', 'argon2', 'build', 'Release', 'argon2.node')) ||
      existsSync(join(cs, 'node_modules', 'argon2', 'prebuilds')));
}

/** 安装目标:
 *   1. profile 布局 → <profile>\code-server-app(npm --prefix 装到
 *      <profile>\code-server-app\node_modules\code-server,独立项目,无 ERESOLVE);
 *   2. 否则回退包内(工作区/独立目录场景)。 */
function installPrefix() {
  const profileRoot = profileRootOf();
  return profileRoot !== null ? join(profileRoot, APP_DIR_NAME) : pkgRoot;
}

function installCodeServer() {
  const prefix = installPrefix();
  const want = desiredVersion();
  const versionSpec = typeof want === 'string' && want !== '' ? `code-server@${want}` : 'code-server';
  console.log(`[setup-code-server] npm 自装 ${versionSpec}(latest)${
    want != null ? '' : ''}(target: ${prefix} → node_modules/code-server)${
    prefix === pkgRoot ? '(包内回退)' : '(profile 专用目录)'}…`);
  // npm 读取 prefix 项目自己的 package.json 的 allowScripts;在安装根写一个最小配置,
  // 让 code-server:false(跳过官方 sh postinstall)、argon2/unrs:true(native 构建)生效。
  // allowScripts 不带版本号(任何 argon2/unrs 版本都构建 native,避免版本变化后失配)。
  const appPkg = join(prefix, 'package.json');
  if (!existsSync(appPkg)) {
    try {
      mkdirSync(prefix, { recursive: true });
      writeFileSync(appPkg, JSON.stringify({
        name: 'dsh-code-server-app',
        private: true,
        version: '0.0.0',
        allowScripts: { 'code-server': false, 'argon2': true, 'unrs-resolver': true },
      }, null, 2), 'utf8');
    } catch (e) {
      console.warn('[setup-code-server] 安装根 package.json 写入失败(allowScripts 可能不生效):', e.message);
    }
  }
  npm([
    'install', versionSpec,
    '--no-save', '--no-audit', '--no-fund', '--prefix', prefix,
  ], prefix);
}

function main() {
  let cs = findCodeServer();
  const want = desiredVersion();
  const have = cs !== null ? installedVersion(cs) : null;
  // 升级判定独立于 isComplete:已有实例且(有 latest 且版本不同)→ 重装到最新。
  if (want != null && have !== null && have !== want) {
    console.log(`[setup-code-server] 当前 code-server@${have},最新 ${want}——自动升级…`);
    installCodeServer();
    cs = findCodeServer();
  } else if (cs !== null && isComplete(cs)) {
    console.log(`[setup-code-server] code-server 已实例化(entry + 内部依赖 + native 均在),跳过${
      have !== null ? `(版本 ${have})` : ''}` + (want != null ? `;latest: ${want}` : ''));
    return;
  }
  if (cs === null || !existsSync(join(cs, 'out', 'node', 'entry.js'))) {
    installCodeServer();
    cs = findCodeServer();
  }
  if (cs === null) {
    console.warn('[setup-code-server] code-server 安装失败(未找到);请检查网络/npm 环境');
    return;
  }

  console.log('[setup-code-server] 补装 VS Code 内部依赖与原生模块…');
  const vscode = join(cs, 'lib', 'vscode');
  ensureNpmDeps(vscode);
  ensureNpmDeps(join(vscode, 'extensions'));

  // bin 入口:Windows 上官方 postinstall 是 mklink /J;此处用 cmdshim 拷贝兜底
  try {
    const bin = join(cs, 'bin');
    mkdirSync(bin, { recursive: true });
    const scriptsDir = join(cs, 'lib', 'vscode', 'bin');
    const remote = join(scriptsDir, 'remote-cli');
    if (existsSync(remote)) {
      for (const name of readdirSync(remote)) {
        if (name.endsWith('.cmd')) {
          copyFileSync(join(remote, name), join(bin, 'code-server.cmd'));
          console.log(`[setup-code-server] bin/code-server.cmd <- ${name}`);
        }
      }
    }
  } catch (e) {
    console.warn('[setup-code-server] bin 入口建立失败(不影响 runtime 启动,host 走 entry.js):', e.message);
  }
  console.log('[setup-code-server] 完成;entry:', existsSync(join(cs, 'out', 'node', 'entry.js')));
}

try {
  main();
} catch (e) {
  console.error('[setup-code-server] 安装失败(插件仍可启动;README 有恢复指引):', e.message);
  process.exitCode = 0; // 不阻断 pnpm/npm install
}
