// scripts/promote.mjs — 把某个版本推进为 npm `latest`(仅当用户重启确认无误后执行)。
//
// 用法:
//   node scripts/promote.mjs 0.1.41             # dsh-code-server-app@0.1.41 → latest
//   node scripts/promote.mjs 0.1.41 --dry-run   # 只打印将要执行的命令与当前标签
//   node scripts/promote.mjs 0.1.41 --pkg @jinsiyu/dsh-code-server   # 推进子包标签
//
// 为什么:发布脚本默认只发 `next`,避免 bug 版本被 `dsh plugin add <不带版本>` 直接装上;
// 确认后再由本脚本(或 `npm dist-tag add`)推进 latest。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const npmCache = join(pkgRoot, '.npm-cache');
const workspaceNpmrc = join(pkgRoot, '.npmrc');
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

function argValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
}
const version = argv.find((a) => /^\d+\.\d+\.\d+/.test(a)) ?? null;
const pkgName = argValue('--pkg') ?? JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).name;
const tag = argValue('--tag') ?? 'latest';

if (version === null) {
  console.error('用法: node scripts/promote.mjs <version> [--pkg <包名>] [--tag latest] [--dry-run]');
  process.exit(1);
}

const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const hasCli = existsSync(cli);
const cmd = hasCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
function npm(args) {
  const full = hasCli ? [cli, ...args] : args;
  const extra = existsSync(workspaceNpmrc) ? ['--userconfig', workspaceNpmrc] : [];
  return spawnSync(cmd, [...full, ...extra], {
    cwd: pkgRoot,
    shell: !hasCli && process.platform === 'win32',
    stdio: 'inherit',
    env: { ...process.env, npm_config_cache: npmCache, npm_config_update_notifier: 'false' },
  });
}

console.log(`[promote] 当前标签(${pkgName}):`);
npm(['dist-tag', 'ls', pkgName]);
if (DRY_RUN) {
  console.log(`[promote] (dry-run) 将执行: npm dist-tag add ${pkgName}@${version} ${tag}`);
  process.exit(0);
}
console.log(`[promote] 推进 ${pkgName}@${version} → ${tag}`);
const res = npm(['dist-tag', 'add', `${pkgName}@${version}`, tag]);
if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);
console.log('[promote] 完成,新标签:');
npm(['dist-tag', 'ls', pkgName]);
