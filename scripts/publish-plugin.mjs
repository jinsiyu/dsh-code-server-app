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
//   node scripts/publish-plugin.mjs --provenance    # 附 Sigstore provenance(CI 里的 OIDC trusted
//                                                   # publishing 用;需要 id-token: write)
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
// provenance 只在 OIDC trusted publishing(id-token: write)下用;本地保持默认关闭。
const PROVENANCE = argv.includes('--provenance');
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

// ── 发布前校验:根目录那份 tarball 必须**就是当前仓库的构建产物** ────────────────────────────
// 为什么必须有:`*.tgz` 是 gitignore 的,上一次打包的残留会一直躺在仓库根目录,而 `npm publish`
// 只认**文件名** —— 同名旧包会被原样发出去,一个字都不会报警。
// 2026-10-04 差一点撞上:根目录那份 dsh-code-server-app-0.3.71.tgz 还是 10-01 的
// (树包 4.139.1 + proxy-agent 0.44.0),而当时 package.json 已经是 4.140.0 / 0.45.0。
//
// 校验口径:解开包里的 package.json,比对 version 与**全部 @jinsiyu/\* 的精确钉版**。
// 这几项都是打包期由 vendor/repack 流程写进去的 —— 它们对不上,就说明这份 tarball
// 不是按当前 package.json 打出来的。不比对 files 清单/时间戳:npm 会按 files 规则重排,
// 而时间戳只能证明"文件被碰过",证明不了"内容是对的"。
function jinsiyuPins(pkg) {
  const out = {};
  for (const fld of ['dependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(pkg?.[fld] ?? {})) {
      if (name.startsWith('@jinsiyu/')) out[name] = spec;
    }
  }
  return out;
}

/** 读 tarball 里的 package/package.json(用系统 tar:Windows 10+ / Linux / macOS / CI 都有)。 */
function readPackedManifest(tgzPath) {
  const res = spawnSync('tar', ['-xzOf', tgzPath, 'package/package.json'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error !== undefined || res.status !== 0) {
    // 读不出来就**拒绝发布**(fail closed):这道门禁的意义就是不让"没验过的包"出去,
    // 环境坏了应当先修环境,而不是退回"不校验直接发"。
    return { ok: false, why: `读不出包内 package.json(tar exit ${res.status}`
      + `${res.error !== undefined ? `,${res.error.code}` : ''})` };
  }
  try {
    return { ok: true, pkg: JSON.parse(res.stdout) };
  } catch (error) {
    return { ok: false, why: `包内 package.json 不是合法 JSON:${error.message}` };
  }
}

function verifyPackedTarball(tgzPath, repoManifest) {
  const read = readPackedManifest(tgzPath);
  if (!read.ok) return read;
  const inner = read.pkg;
  const problems = [];
  if (inner.version !== repoManifest.version) {
    problems.push(`version 包内 ${inner.version} ≠ 仓库 ${repoManifest.version}`);
  }
  const packed = jinsiyuPins(inner);
  const repo = jinsiyuPins(repoManifest);
  for (const name of [...new Set([...Object.keys(packed), ...Object.keys(repo)])].sort()) {
    if (packed[name] !== repo[name]) {
      problems.push(`${name} 包内 ${packed[name] ?? '(无)'} ≠ 仓库 ${repo[name] ?? '(无)'}`);
    }
  }
  if (problems.length > 0) return { ok: false, why: problems.join('; '), pins: Object.keys(repo).length };
  return { ok: true, pins: Object.keys(repo).length };
}

const verified = verifyPackedTarball(tgz, manifest);
if (!verified.ok) {
  console.error(`[publish] ✗ 拒绝发布:${relative(pkgRoot, tgz)} 不是当前 package.json 的构建产物`);
  console.error(`[publish]   ${verified.why}`);
  console.error('[publish]   根目录的 *.tgz 是 gitignore 的,旧包会一直躺着,而 npm publish 只认文件名。');
  console.error('[publish]   请重打一份并在输出里确认它真的写了文件(时间戳会变):pnpm pack');
  process.exit(1);
}
console.log(`[publish] tarball 校验通过:${verified.pins} 个 @jinsiyu/* 钉版与 package.json 一致`);

const args = ['publish', relative(pkgRoot, tgz), '--access', 'public', '--tag', TAG];
if (existsSync(workspaceNpmrc)) args.push('--userconfig', workspaceNpmrc);
if (PROVENANCE) args.push('--provenance');
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
