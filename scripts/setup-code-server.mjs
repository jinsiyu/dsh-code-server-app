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
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // .../dsh-code-server/scripts
const pkgRoot = join(here, '..'); // <profile>\node_modules\dsh-code-server

const CODE_SERVER_VERSION = '4.134.0';

function run(cmd, args, cwd) {
  const useShell = process.platform === 'win32';
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: useShell });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${res.status})`);
}

function npm(cmdArgs, cwd) {
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', cmdArgs, cwd);
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
  //   2. 与主包平级:profileRoot\node_modules\code-server(pnpm hoisted,历史布局)
  //   3. 包内:pkgRoot/node_modules/code-server(回退/独立目录)
  const profileRoot = profileRootOf();
  const cands = [];
  if (profileRoot !== null) {
    cands.push(join(profileRoot, APP_DIR_NAME, 'node_modules', 'code-server'));
    cands.push(join(profileRoot, 'node_modules', 'code-server'));
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
  console.log(`[setup-code-server] npm 自装 code-server@${CODE_SERVER_VERSION}(target: ${prefix} → node_modules/code-server)${
    prefix === pkgRoot ? '(包内回退)' : '(profile 专用目录)'}…`);
  // npm 读取 prefix 项目自己的 package.json 的 allowScripts;在安装根写一个最小配置,
  // 让 code-server:false(跳过官方 sh postinstall)、argon2/unrs:true(native 构建)生效。
  const appPkg = join(prefix, 'package.json');
  if (!existsSync(appPkg)) {
    try {
      mkdirSync(prefix, { recursive: true });
      writeFileSync(appPkg, JSON.stringify({
        name: 'dsh-code-server-app',
        private: true,
        version: '0.0.0',
        allowScripts: { 'code-server': false, 'argon2@0.44.0': true, 'unrs-resolver@1.11.1': true },
      }, null, 2), 'utf8');
    } catch (e) {
      console.warn('[setup-code-server] 安装根 package.json 写入失败(allowScripts 可能不生效):', e.message);
    }
  }
  npm([
    'install', `code-server@${CODE_SERVER_VERSION}`,
    '--no-save', '--no-audit', '--no-fund', '--prefix', prefix,
  ], prefix);
}

function main() {
  let cs = findCodeServer();
  if (cs !== null && isComplete(cs)) {
    console.log('[setup-code-server] code-server 已实例化(entry + 内部依赖 + native 均在),跳过');
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
