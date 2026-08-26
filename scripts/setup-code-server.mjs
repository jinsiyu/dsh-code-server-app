// scripts/setup-code-server.mjs — Windows 兼容的 code-server postinstall 等价实现。
//
// npm 官方 code-server 的 postinstall 是 `sh ./postinstall.sh`(依赖 bash/symlink),
// 在 Windows 上 npm 没有 sh(除非 git-bash 在 PATH),安装直接失败。
// 本脚本用纯 Node 完成同一件事,由本插件的 package.json postinstall 调用:
//   1. 定位依赖安装的 code-server(node_modules/code-server);
//   2. 在其 lib/vscode 与 lib/vscode/extensions 下执行 `npm install --omit=dev`
//      (构建 VS Code 依赖与原生模块——node-gyp+MSVC 环境由 README 前置安装);
//   3. 创建 bin 入口(Windows 用 .cmd 拷贝代替 symlink)。
// 幂等:已实例化时跳过;失败不中断插件安装(启动时 host 还会探测并给指引)。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // .../dsh-code-server-app/scripts
const pkgRoot = join(here, '..');

function run(cmd, args, cwd) {
  const useShell = process.platform === 'win32';
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: useShell });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${res.status})`);
}

function ensureNpmDeps(dir) {
  if (!existsSync(join(dir, 'package.json'))) return;
  // --omit=dev:只装生产依赖(native 模块在 #postinstall 内建)
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], dir);
}

function findCodeServer() {
  // 布局候选:
  //   1. pkgRoot/node_modules/code-server(npm/flat 安装)
  //   2. pkgRoot/../code-server(pnpm hoisted:依赖装到宿主顶层 node_modules)
  for (const cand of [
    join(pkgRoot, 'node_modules', 'code-server'),
    join(pkgRoot, '..', 'code-server'),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

function main() {
  const cs = findCodeServer();
  if (cs === null) {
    console.warn('[setup-code-server] code-server 未找到(未安装或布局不同);请检查依赖安装');
    return;
  }
  const entry = join(cs, 'out', 'node', 'entry.js');
  const inner = join(cs, 'lib', 'vscode', 'node_modules');
  const innerOk = existsSync(inner) && existsSync(join(inner, '@vscode', 'ripgrep'));
  if (existsSync(entry) && innerOk) {
    console.log('[setup-code-server] code-server 已实例化(entry + VS Code 内部依赖均在),跳过');
    return;
  }
  console.log('[setup-code-server] 安装 VS Code 依赖与原生模块(node-gyp 13 + MSVC 已就绪时)…');
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
  console.log('[setup-code-server] 完成;entry:', existsSync(entry));
}

try {
  main();
} catch (e) {
  console.error('[setup-code-server] 安装失败(插件仍可启动;README 有恢复指引):', e.message);
  process.exitCode = 0; // 不阻断 npm install
}
