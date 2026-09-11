// scripts/dev-deploy.mjs —— 把当前工作区的 Phase 1 构建部署进某个 profile(开发循环用)
//
// 为什么不用 pnpm add:profile 里的插件是登记在 manifest 里的版本,开发迭代只需要把
// 构建产物覆盖进已安装目录。注意 **必须先删后拷**:profile 的 node_modules 是 pnpm 硬链接,
// 直接覆盖会写坏 store 里的副本。
//
// 用法:
//   node scripts/dev-deploy.mjs desktop            # 部署 lib/* + 给工作台 bundle 打 B2 补丁
//   node scripts/dev-deploy.mjs desktop --revert   # 还原工作台 bundle(插件文件不动)
//   node scripts/dev-deploy.mjs web                # web profile 只部署 lib/*(没有 B2 补丁)
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const argv = process.argv.slice(2);
const profile = argv.find((a) => !a.startsWith('--'));
const revert = argv.includes('--revert');

if (profile !== 'desktop' && profile !== 'web') {
  console.error('用法: node scripts/dev-deploy.mjs <desktop|web> [--revert]');
  process.exit(1);
}

const pluginDir = join(homedir(), '.dsh', 'profiles', profile, 'node_modules', 'dsh-code-server-app');
if (!existsSync(pluginDir)) {
  console.error(`profile 里没有装本插件:${pluginDir}`);
  process.exit(1);
}

const workbench = join(homedir(), '.dsh', 'profiles', profile, 'node_modules', '@jinsiyu',
  'dshcs-vscode-server', 'vscode', 'lib', 'vscode', 'out', 'vs', 'code', 'browser', 'workbench', 'workbench.js');

if (revert) {
  if (!existsSync(workbench)) {
    console.error(`找不到工作台 bundle:${workbench}`);
    process.exit(1);
  }
  execFileSync(process.execPath, [join(root, 'scripts', 'patch-vscode-bundle.mjs'), workbench, '--revert'], { stdio: 'inherit' });
  process.exit(0);
}

const FILES = ['index.js', 'client.js', 'launcher.mjs', 'pipe-tunnel.mjs', 'native.js', 'serve-dsh.mjs', 'vendor.js'];
mkdirSync(join(pluginDir, 'lib'), { recursive: true });
for (const name of FILES) {
  const from = join(root, 'lib', name);
  if (!existsSync(from)) continue;
  const to = join(pluginDir, 'lib', name);
  rmSync(to, { force: true });
  copyFileSync(from, to);
  console.log(`[deploy] lib/${name} ${statSync(from).size} B`);
}

if (existsSync(workbench)) {
  execFileSync(process.execPath, [join(root, 'scripts', 'patch-vscode-bundle.mjs'), workbench], { stdio: 'inherit' });
} else {
  console.log(`[deploy] 未找到工作台 bundle,跳过 B2 补丁:${workbench}`);
}

console.log(`[deploy] 完成(${profile})。host 半部改动需要重启应用生效;客户端 bundle 由 client-hmr 热替换(可能需刷新)。`);
