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
