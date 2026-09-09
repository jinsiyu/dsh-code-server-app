// scripts/publish-repacks.mjs — 把 repack/ 下的预编译包与平台聚合包发布到 npm。
//
// 前提:先 `node scripts/vendor-repacks.mjs --target win32-arm64,win32-x64 --pack`
//       生成 repack/build/*(重打包的原生包)与 repack/aggregator/*(平台聚合包)。
//       本脚本只负责发布(以及发布前的最小校验)。
//
// 用法:
//   node scripts/publish-repacks.mjs --dry-run          # 只打印将要发布的包
//   node scripts/publish-repacks.mjs                    # 发布全部
//   node scripts/publish-repacks.mjs --only node-pty    # 只发布名字包含该子串的包
//   node scripts/publish-repacks.mjs --tag beta         # 指定 dist-tag
//   node scripts/publish-repacks.mjs --otp 123456       # 账号开启 2FA 时传一次性口令
//   node scripts/publish-repacks.mjs --limit 5 --otp …  # 一批最多 5 个(口令约 30 秒过期,可重跑续发)
//   node scripts/publish-repacks.mjs --no-skip-published  # 不跳过已存在版本(默认跳过)
//
// 发布顺序:先发重打包的原生包,再发聚合包(聚合包依赖它们)。
// 已发布的同名版本会被跳过(npm 不允许覆盖同版本),因此可安全重跑。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repackDir = join(pkgRoot, 'repack');
const npmCache = join(pkgRoot, '.npm-cache');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const SKIP_PUBLISHED = !argv.includes('--no-skip-published');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
})();
const TAG = (() => {
  const i = argv.indexOf('--tag');
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
})();
// 账号开启 2FA(auth-and-writes)时,每次写操作都要一次性口令;口令约 30 秒过期,
// 因此 26 个包通常需要分几次(每次传新口令),或用能绕过 2FA 的 granular token。
const OTP = (() => {
  const i = argv.indexOf('--otp');
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : (process.env.NPM_OTP ?? null);
})();
// 一批最多发布几个(配合一次性口令;已发布的会被跳过,可反复重跑续发)。
const LIMIT = (() => {
  const i = argv.indexOf('--limit');
  const n = i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
})();

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// npm 只读「当前项目目录」的 .npmrc;repack/build/<pkg> 自带 package.json,
// 所以工作区根的 .npmrc(发布 token)必须显式用 --userconfig 指给 npm。
const WORKSPACE_NPMRC = join(pkgRoot, '.npmrc');
const NPMRC_ARGS = existsSync(WORKSPACE_NPMRC) ? ['--userconfig', WORKSPACE_NPMRC] : [];

/** npm 直调 npm-cli.js(避免 shell 引号问题);缓存放工作区内(沙箱下 AppData 不可写)。
 *  注意:一律 stdio:'inherit' —— 沙箱下「管道捕获子进程输出」会被拒(spawn EPERM),
 *  所以版本探测改用 registry HTTP 接口(见 registryHas),不捕获 npm 输出。 */
function npm(args, cwd) {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const env = { ...process.env, npm_config_cache: npmCache, npm_config_update_notifier: 'false' };
  const hasCli = existsSync(cli);
  const cmd = hasCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const full = hasCli ? [cli, ...args, ...NPMRC_ARGS] : [...args, ...NPMRC_ARGS];
  const useShell = !hasCli && process.platform === 'win32';
  return spawnSync(cmd, full, { cwd, shell: useShell, env, stdio: 'inherit' });
}

const REGISTRY = 'https://registry.npmjs.org';

/** 该包版本是否已在 registry(直连 HTTP,绕过 npm 缓存;新发布有传播延迟 → 可重试)。 */
async function registryHas(name, version, { retries = 0, delayMs = 4000 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`, { headers: { 'cache-control': 'no-cache' } });
      if (res.status === 200) {
        const doc = await res.json();
        if (doc !== null && doc.versions !== undefined && doc.versions[version] !== undefined) return true;
        return false;
      }
    } catch { /* 网络抖动 → 当作未知,继续重试 */ }
    if (attempt >= retries) return false;
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/** 递归统计 .node 文件数(平台专属包必须 >0;含嵌套 node_modules——
 *  code-server 子包的 argon2 二进制就在 code-server/node_modules 下)。 */
function countNodeFiles(dir) {
  let n = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries; try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(join(cur, e.name));
      else if (e.name.endsWith('.node')) n += 1;
    }
  }
  return n;
}

/** 收集待发布目录:{ dir, name, version, aggregator }。 */
function collect() {
  const out = [];
  const buildRoot = join(repackDir, 'build');
  if (existsSync(buildRoot)) {
    for (const name of readdirSync(buildRoot).sort()) {
      const dir = join(buildRoot, name);
      const manifest = readJson(join(dir, 'package.json'));
      if (manifest === null) continue;
      out.push({ dir, name: manifest.name, version: manifest.version, aggregator: false, platform: manifest.cpu?.[0] ?? null });
    }
  }
  const aggRoot = join(repackDir, 'aggregator');
  if (existsSync(aggRoot)) {
    for (const target of readdirSync(aggRoot).sort()) {
      const dir = join(aggRoot, target);
      const manifest = readJson(join(dir, 'package.json'));
      if (manifest === null) continue;
      out.push({ dir, name: manifest.name, version: manifest.version, aggregator: true, platform: target });
    }
  }
  return out;
}

async function main() {
  if (!existsSync(repackDir)) {
    throw new Error('缺少 repack/;先运行 `node scripts/vendor-repacks.mjs --target win32-arm64,win32-x64 --pack`');
  }
  let items = collect();
  if (ONLY !== null) items = items.filter((i) => i.name.includes(ONLY));
  if (items.length === 0) throw new Error('没有匹配的包可发布');

  // 预检:平台专属包必须带二进制
  const problems = [];
  for (const item of items) {
    if (item.aggregator) continue;
    const n = countNodeFiles(item.dir);
    if (item.platform !== null && n === 0) problems.push(`${item.name}@${item.version} 无 .node 二进制(${relative(pkgRoot, item.dir)})`);
  }
  if (problems.length > 0) {
    console.error('[publish] 以下平台专属包缺少二进制,先修好再发布:');
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[publish] 待发布 ${items.length} 个包${DRY_RUN ? ' | DRY-RUN' : ''}${NPMRC_ARGS.length > 0 ? ` | 凭据 ${relative(pkgRoot, WORKSPACE_NPMRC)}` : ' | 未找到工作区 .npmrc(用默认登录态)'}`);

  let published = 0;
  let skipped = 0;
  let failed = 0;
  let attempted = 0;
  for (const item of items) {
    if (LIMIT !== null && attempted >= LIMIT) break;
    const label = `${item.name}@${item.version}`;
    if (DRY_RUN) {
      console.log(`[publish] (dry-run) ${label}  ← ${relative(pkgRoot, item.dir)}`);
      attempted += 1;
      continue;
    }
    if (SKIP_PUBLISHED && await registryHas(item.name, item.version)) {
      console.log(`[publish] 跳过(已存在) ${label}`);
      skipped += 1;
      continue;
    }
    const args = ['publish', '--access', 'public'];
    // 预发布版本(node-pty 1.2.0-beta.15 / sqlite3 5.1.12-vscode)npm 要求显式 --tag;
    // 依赖方按精确版本解析,dist-tag 不影响安装。
    const tag = TAG ?? (/-/.test(item.version) ? 'next' : null);
    if (tag !== null) args.push('--tag', tag);
    if (OTP !== null) args.push(`--otp=${OTP}`);
    attempted += 1;
    console.log(`[publish] 发布 ${label}${tag !== null ? ` (tag=${tag})` : ''}`);
    const res = npm(args, item.dir);
    if (res.status === 0) {
      published += 1;
      console.log(`[publish] ✓ ${label}`);
      continue;
    }
    // 失败可能是「已发布」或传播延迟;重查一次 registry 再定性。
    if (await registryHas(item.name, item.version, { retries: 2, delayMs: 4000 })) {
      skipped += 1;
      console.log(`[publish] 跳过(已存在) ${label}`);
    } else {
      failed += 1;
      console.error(`[publish] 失败: ${label} (exit ${res.status})`);
    }
  }
  console.log(`[publish] 完成:发布 ${published} 个,跳过 ${skipped} 个,失败 ${failed} 个${LIMIT !== null ? `(本批上限 ${LIMIT})` : ''}`);
  if (failed > 0) process.exitCode = 1;
  console.log('[publish] 提示:发布后 bump 插件版本并 `pnpm pack`,再 `dsh plugin --profile web add <tgz>`');
}

await main();
