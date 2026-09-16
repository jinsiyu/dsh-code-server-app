#!/usr/bin/env node
// oidc-probe.mjs —— 验证「per-package trusted publishing(OIDC)」发布通道的巡检脚本。
//
// 为什么需要它:子包(`@jinsiyu/dshcs-*`)在没有 NPM_TOKEN 时靠 OIDC + 每个包一条
// Trusted Publisher 发布。这条通道**没法离线验证**——OIDC 令牌只在 CI 运行时签发,而且信任关系
// 按「仓库 + workflow 文件名 + 包名」匹配。所以唯一诚实的验证方式是:在 Actions 里对**真实包名**
// 发起一次发布,看 npm 是否接受这次 OIDC 认证。
//
// 为了不产生任何正式版本,这里用 npm 的 **staged publishing**(`npm stage publish`):
//   · 版本进入暂存队列,**不进** registry 的正式版本列表(脚本自己用 `npm view versions` 证明);
//   · 走的是与 `npm publish` **完全相同**的 OIDC ↔ Trusted Publisher 认证路径(publish / stage publish
//     在信任关系里是两个并列权限,本仓库 25 条两条都给了);
//   · 由维护者 `npm stage reject <id>` 作废(或等它过期),因此不会影响任何依赖解析。
//
// 用法:
//   node scripts/oidc-probe.mjs --dry-run      # 只准备探针目录 + 打印参数,绝不碰 registry(本地可跑)
//   node scripts/oidc-probe.mjs                # 真正暂存(默认 4 个代表包;需在 Actions 里跑)
//   node scripts/oidc-probe.mjs --packages @scope/a,@scope/b --tag oidc-probe --no-provenance
//
// 退出码:0 = 全部暂存成功;1 = 有包失败(已转成 `::error::` annotation,无需登录即可读)。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';

// 4 个代表包,覆盖四种形态(全部与真实子包同名,才能验证那一条信任关系):
//   · vscode-fs-copyfile      平台无关、普通三段版本
//   · node-pty                平台无关、基版本本身是预发布(1.2.0-beta.15)
//   · kerberos-win32-arm64    平台专属、版本带自家后缀(2.1.1-dshcs.1)
//   · vscode-server           内置 VS Code 树包(最关键的一个)
const DEFAULT_PACKAGES = [
  '@jinsiyu/dshcs-vscode-fs-copyfile',
  '@jinsiyu/dshcs-node-pty',
  '@jinsiyu/dshcs-kerberos-win32-arm64',
  '@jinsiyu/dshcs-vscode-server',
];

// ---------- 参数 ----------

const argv = process.argv.slice(2);

function flag(name) {
  return argv.includes(name);
}

function opt(name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

const DRY_RUN = flag('--dry-run');
const PROVENANCE = !flag('--no-provenance');
const TAG = opt('--tag', 'oidc-probe');
const SUFFIX = opt('--suffix') ?? `${process.env.GITHUB_RUN_NUMBER ?? Date.now()}${process.env.GITHUB_RUN_ATTEMPT ? `.${process.env.GITHUB_RUN_ATTEMPT}` : ''}`;
const PROBE_DIR = resolve(opt('--dir', join(ROOT, '.oidc-probe')));
const PACKAGES = (opt('--packages') ?? DEFAULT_PACKAGES.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ---------- 输出(CI 里额外发 annotation:Actions 原始日志要登录,annotation 不用) ----------

function annotate(level, message) {
  const line = String(message).replace(/\r?\n/g, ' ⏎ ');
  console.log(IN_ACTIONS ? `::${level}::${line}` : `[${level}] ${line}`);
}

// ---------- npm ----------

// Windows 上 `npm` 是 npm.cmd:Node 20 起 `.cmd` 不能再被直接 spawn(必须经 shell),
// 所以 Windows 用 shell 并把带空格的参数自己加引号;POSIX 直接 exec(`npm` 是指向 npm-cli.js 的软链)。
const USE_SHELL = process.platform === 'win32';
const NPM = USE_SHELL ? 'npm' : 'npm';

function npm(args, { quiet = false } = {}) {
  const finalArgs = USE_SHELL ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
  const r = spawnSync(NPM, finalArgs, { encoding: 'utf8', cwd: ROOT, env: process.env, shell: USE_SHELL });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() || (r.error ? String(r.error.message) : '');
  if (!quiet && out) for (const line of out.split(/\r?\n/)) console.log(`    │ ${line}`);
  return { code: r.status ?? 1, out };
}

// 返回 {ok, value} 或 {ok:false, error}:把 npm 的原始错误带回去,annotation 里能一眼看出原因。
function npmView(name, field) {
  const r = npm(['view', name, field, '--json'], { quiet: true });
  if (r.code !== 0) return { ok: false, error: r.out };
  try {
    return { ok: true, value: JSON.parse(r.out) };
  } catch {
    return { ok: true, value: r.out.replace(/^"|"$/g, '').trim() };
  }
}

function publishedVersions(name) {
  const r = npmView(name, 'versions');
  if (!r.ok) return null;
  if (Array.isArray(r.value)) return r.value;
  return typeof r.value === 'string' && r.value ? [r.value] : null;
}

// 为什么不用 `npm view <pkg> version`(latest 标签):本仓库的政策是**只推 next**,
// 所以 latest 可能落后于已发布过的版本(实测 vscode-server 的 latest = 4.136.2,但树里钉的是 4.137.0)。
// 探针版本必须比**已发布过的最高版本**还高,才不会被 npm 当成"往回发"。
function compareVersions(a, b) {
  const [ac, ap] = a.split('-', 2);
  const [bc, bp] = b.split('-', 2);
  const an = ac.split('.').map(Number);
  const bn = bc.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = an[i] || 0;
    const y = bn[i] || 0;
    if (x !== y) return x - y;
  }
  if (ap === undefined && bp === undefined) return 0;
  if (ap === undefined) return 1; // 正式版 > 预发布
  if (bp === undefined) return -1;
  const as = ap.split('.');
  const bs = bp.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i += 1) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1; // 前缀短的更小
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (xn !== yn) {
      return xn ? -1 : 1; // 数字标识符 < 字母标识符
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// ---------- 探针包 ----------

// 只做一件事:在已经发布过的版本之上抬一个 patch,再挂 `-<tag>.<suffix>` 预发布后缀。
// 预发布后缀保证:即使有人误 approve,也不会顶掉 latest / next 这些 dist-tag。
function probeVersion(base, name) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(base ?? '');
  if (!m) {
    annotate('error', `无法从 "${base}" 解析版本(${name})`);
    return null;
  }
  const [, major, minor, patch] = m;
  return `${major}.${minor}.${Number(patch) + 1}-${TAG}.${SUFFIX}`;
}

function writeProbePackage(name, version, repository) {
  const slug = name.replace(/^@/, '').replace(/\//g, '__');
  const dir = join(PROBE_DIR, slug);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const manifest = {
    name,
    version,
    description: 'OIDC 发布通道巡检用的暂存包:与真实子包同名、内容为空壳,验证完请 reject(见 PROBE.md)',
    license: 'MIT',
    files: ['PROBE.md'],
    ...(repository ? { repository } : {}),
  };
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(dir, 'PROBE.md'),
    [
      `# ${name}@${version} —— OIDC 通道巡检(非真实产物)`,
      '',
      '这个版本是 `repacks.yml` 里 **OIDC 巡检 job** 暂存(staged)出来的探针,用来验证',
      '`@jinsiyu/dshcs-*` 的 per-package trusted publishing 是否可用。',
      '',
      '它**不是**任何真实产物:没有内容,也没有进入 registry 的正式版本列表。',
      '',
      '处理方式:`npm stage reject <stage-id>`(2FA)或在 npm 网页的 staged publishes 里 reject。',
      '不要 approve —— approve 才会让它变成正式版本。',
      '',
    ].join('\n'),
  );
  return dir;
}

// ---------- 主流程 ----------

function main() {
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const repository = rootPkg.repository ?? null;

  console.log('OIDC 通道巡检(staged publishing)');
  console.log(`  仓库      : ${repository?.url ?? '(package.json 里没有 repository)'}`);
  console.log(`  暂存 tag  : ${TAG}`);
  console.log(`  版本后缀  : ${SUFFIX}`);
  console.log(`  探针目录  : ${PROBE_DIR}`);
  console.log(`  provenance: ${PROVENANCE ? '开(失败会自动退化为不带 provenance)' : '关'}`);
  console.log(`  模式      : ${DRY_RUN ? '--dry-run(不碰 registry)' : '真实暂存'}`);
  console.log(`  包(${PACKAGES.length})   : ${PACKAGES.join(', ')}`);
  console.log('');

  mkdirSync(PROBE_DIR, { recursive: true });

  const results = [];

  for (const name of PACKAGES) {
    console.log(`── ${name}`);
    const versions = publishedVersions(name);
    let base = versions && versions.length > 0 ? [...versions].sort(compareVersions).at(-1) : null;
    if (base === null) {
      const latest = npmView(name, 'version');
      if (latest.ok && typeof latest.value === 'string') {
        base = latest.value;
        console.log('   (取不到 versions 列表,退回 latest 标签)');
      } else {
        const why = latest.ok ? `返回了非字符串版本(${JSON.stringify(latest.value)})` : (latest.error.split(/\r?\n/).filter(Boolean).slice(-2).join(' ⏎ ') || 'npm view 失败');
        annotate('error', `OIDC 巡检:取不到 ${name} 的当前版本 —— ${why}`);
        results.push({ name, ok: false, reason: 'npm view 失败', tail: [why] });
        continue;
      }
    }
    const version = probeVersion(base, name);
    if (version === null) {
      results.push({ name, ok: false, reason: `版本解析失败(base=${base})` });
      continue;
    }
    console.log(`   当前版本 ${base} ⇒ 探针版本 ${version}`);
    const dir = writeProbePackage(name, version, repository);

    const args = ['stage', 'publish', dir, '--tag', TAG, '--access', 'public'];
    if (PROVENANCE) args.push('--provenance');
    if (DRY_RUN) args.push('--dry-run');

    console.log(`   $ npm ${args.join(' ')}`);
    let r = npm(args);
    let usedProvenance = PROVENANCE;

    // provenance 需要 git 检出干净 + CI 环境;拿不到就退化成不带 provenance 再试一次,
    // 因为本次巡检要验证的是 **认证通道**,不是 attestation。
    if (r.code !== 0 && PROVENANCE) {
      console.log('   ↳ 带 --provenance 失败,去掉它重试一次(认证结论不受影响)');
      usedProvenance = false;
      r = npm(args.filter((a) => a !== '--provenance'));
    }

    if (r.code !== 0) {
      const tail = r.out.split(/\r?\n/).filter(Boolean).slice(-4);
      for (const line of tail) annotate('error', `OIDC 巡检 ${name}:${line}`);
      annotate('error', `OIDC 巡检失败:${name}@${version} 未能暂存 ⇒ 这条 Trusted Publisher 或权限有问题`);
      results.push({ name, version, ok: false, reason: 'stage publish 失败', tail });
      continue;
    }

    // 自证安全:探针版本必须**不在**正式版本列表里。
    let liveLeak = null;
    if (!DRY_RUN) {
      const versions = publishedVersions(name);
      liveLeak = versions === null ? null : versions.includes(version);
      if (liveLeak === true) {
        annotate('error', `OIDC 巡检异常:探针版本 ${name}@${version} 出现在正式版本列表里(应立即 reject)`);
        results.push({ name, version, ok: false, reason: '探针版本意外进入正式版本列表' });
        continue;
      }
    }

    console.log(`   ✓ 暂存成功${usedProvenance ? '(带 provenance)' : '(无 provenance)'}${liveLeak === false ? ',且未进入正式版本列表' : ''}`);
    annotate('notice', `OIDC 巡检通过:${name}@${version} 已暂存${usedProvenance ? '(provenance 正常)' : '(provenance 不可用)'}${liveLeak === false ? ',正式版本列表未变' : ''}`);
    results.push({ name, version, ok: true, provenance: usedProvenance, liveLeak });
  }

  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  const report = {
    mode: DRY_RUN ? 'dry-run' : 'stage-publish',
    tag: TAG,
    suffix: SUFFIX,
    provenance: PROVENANCE,
    packages: results,
  };
  const reportPath = join(PROBE_DIR, 'probe-result.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log('');
  console.log(`结果:${passed.length}/${results.length} 通过 ⇒ ${reportPath}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results
      .map((r) => `| \`${r.name}\` | \`${r.version ?? '-'}\` | ${r.ok ? '✅ 暂存成功' : `❌ ${r.reason}`} |`)
      .join('\n');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        '### OIDC 通道巡检(staged publishing)',
        '',
        `模式 \`${report.mode}\` · 暂存 tag \`${TAG}\` · 后缀 \`${SUFFIX}\``,
        '',
        '| 包 | 探针版本 | 结果 |',
        '|---|---|---|',
        rows,
        '',
        '> 暂存版本不会进入正式版本列表;验证完请在 npm 的 staged publishes 里 **reject**(不要 approve)。',
        '',
      ].join('\n'),
    );
  }

  if (failed.length > 0) {
    annotate('error', `OIDC 巡检:${failed.length}/${results.length} 个包失败 ⇒ ${failed.map((f) => f.name).join(', ')}`);
    process.exitCode = 1;
  } else {
    annotate('notice', `OIDC 巡检:${passed.length}/${results.length} 个包全部通过(暂存队列里有 ${passed.length} 个待 reject 的探针版本)`);
  }
}

if (!existsSync(join(ROOT, 'package.json'))) {
  console.error(`找不到 package.json(仓库根应为 ${ROOT})`);
  process.exit(1);
}

main();
