// scripts/publish-plugin.mjs — 发布插件本体 tarball(打包产物)。
//
// 标签政策(用户要求):**默认发到 `next`**,不动 `latest`;
// `latest` 只在用户重启 dsh web 确认无误后,用 `node scripts/promote.mjs <版本>` 推进。
// 这样 `dsh plugin add dsh-code-server-app`(不带版本)永远拿到"最近确认无 bug"的那一版。
//
// 用法:
//   node scripts/publish-plugin.mjs                 # 发布当前版本到 next
//   node scripts/publish-plugin.mjs --tag beta      # 指定 dist-tag
//   node scripts/publish-plugin.mjs --dry-run       # 只打印将发布的 tarball
//   node scripts/publish-plugin.mjs --latest        # 明确推到 latest(仅确认无误后使用)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const npmCache = join(pkgRoot, '.npm-cache');
const workspaceNpmrc = join(pkgRoot, '.npmrc');
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const TAG = (() => {
  if (argv.includes('--latest')) return 'latest';
  const i = argv.indexOf('--tag');
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : 'next';
})();

const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
const tgz = join(pkgRoot, `dsh-code-server-app-${manifest.version}.tgz`);
if (!existsSync(tgz)) {
  console.error(`缺少 ${relative(pkgRoot, tgz)};先运行 \`pnpm pack\``);
  process.exit(1);
}

// 发布前门禁:运行时文件必须都已构建、且都在 package.json 的 files 里。
// 2026-09-11 漏过 lib/pipe-ws.js(它此前只在 dev-deploy 时拷进 profile,工作区 lib/ 里没有 →
// 别人装到的版本会退化成 loopback WS)。这里只做文件系统检查,不 spawn(沙箱里 spawn 管道会 EPERM)。
const REQUIRED_FILES = [
  'lib/index.js',
  'lib/client.js',
  'lib/launcher.mjs',
  'lib/pipe-tunnel.mjs',
  'lib/asset-mirror.mjs',
  'lib/pipe-ws.js',
  'lib/serve-dsh.mjs',
  'lib/vendor.js',
  'lib/native.js',
];
{
  const missing = REQUIRED_FILES.filter((name) => !existsSync(join(pkgRoot, name)));
  if (missing.length > 0) {
    console.error(`[publish] 缺少运行时文件,拒绝发布:${missing.join(', ')}`);
    console.error('[publish] 先运行 `node scripts/build-client.mjs`(生成 lib/client.js 与 lib/pipe-ws.js)。');
    process.exit(1);
  }
  const notShipped = REQUIRED_FILES.filter((name) => !(manifest.files ?? []).includes(name));
  if (notShipped.length > 0) {
    console.error(`[publish] package.json 的 files 未包含:${notShipped.join(', ')}`);
    process.exit(1);
  }
  console.log(`[publish] 运行时文件校验通过(${REQUIRED_FILES.length} 个齐全且都在 files 里)`);
}
const args = ['publish', relative(pkgRoot, tgz), '--access', 'public', '--tag', TAG];
if (existsSync(workspaceNpmrc)) args.push('--userconfig', workspaceNpmrc);
if (DRY_RUN) args.push('--dry-run');

const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const hasCli = existsSync(cli);
const cmd = hasCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const full = hasCli ? [cli, ...args] : args;
console.log(`[publish] dsh-code-server-app@${manifest.version} → dist-tag ${TAG}${DRY_RUN ? ' (dry-run)' : ''}`);
const res = spawnSync(cmd, full, {
  cwd: pkgRoot,
  shell: !hasCli && process.platform === 'win32',
  stdio: 'inherit',
  env: { ...process.env, npm_config_cache: npmCache, npm_config_update_notifier: 'false' },
});
if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);
console.log(`[publish] 完成。用户在 dsh web 里重启并确认无误后,再执行:`);
console.log(`[publish]   node scripts/promote.mjs ${manifest.version}    # 把 latest 推进到该版本`);
