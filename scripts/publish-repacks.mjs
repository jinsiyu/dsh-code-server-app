// scripts/publish-repacks.mjs — 把 repack/ 下的预编译子包(VS Code 树 + 重打包原生包)发布到 npm。
//
// 前提:先 `node scripts/vendor-repacks.mjs --target win32-arm64,win32-x64 --pack`
//       生成 repack/build/*(重打包的原生包)与树包。0.3.45 起**不再有平台聚合包**
//       (重打包包直接挂在插件依赖上,见 docs/desktop-first-install-root-cause.md)。
//       本脚本只负责发布(以及发布前的最小校验)。
//
// 用法:
//   node scripts/publish-repacks.mjs --dry-run          # 只打印将要发布的包
//   node scripts/publish-repacks.mjs                    # 发布全部(默认 dist-tag = next)
//   node scripts/publish-repacks.mjs --only node-pty    # 只发布名字包含该子串的包
//   node scripts/publish-repacks.mjs --only-independent # 只发平台无关层(独立那条腿用;与 --only 互斥)
//   node scripts/publish-repacks.mjs --tag latest       # 明确推到 latest(仅确认无误后)
//   node scripts/publish-repacks.mjs --otp 123456       # 账号开启 2FA 时传一次性口令
//   node scripts/publish-repacks.mjs --limit 5 --otp …  # 一批最多 5 个(口令约 30 秒过期,可重跑续发)
//   node scripts/publish-repacks.mjs --no-skip-published  # 不跳过已存在版本(默认跳过)
//
// 标签政策:默认发 `next`,不碰 `latest`;`latest` 只由 `scripts/promote.mjs` 在用户确认后推进。
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
// 只发「平台无关层」:平台专属包的清单里有 os/cpu(即 item.platform !== null),平台无关的没有。
const ONLY_INDEPENDENT = argv.includes('--only-independent');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
})();
const TAG = (() => {
  const i = argv.indexOf('--tag');
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  // 默认发到 `next`:子包被依赖以精确/插入符版本引用,dist-tag 不影响解析;
  // 这样一次发布不会把 `latest` 指向可能有 bug 的版本(插件本体同理,见 publish-plugin.mjs)。
  return 'next';
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
  // 历史包袱:0.3.44 及更早会生成 repack/aggregator/*(平台聚合包)。目录还在时一并发布,
  // 以免老插件的 optionalDependencies(`^0.3.x`)解析不到;0.3.45 起不再生成。
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
  // --only-independent:只发平台无关层(没有目标后缀的那批)。平台无关层由单独一条腿先跑先发,
  // 平台专属腿各自带 `--only <目标>` ⇒ 两条集合不相交,谁都不会重复发同一个包名。
  if (ONLY_INDEPENDENT) {
    if (ONLY !== null) throw new Error('--only-independent 与 --only 不能同时给');
    items = items.filter((i) => i.platform === null && !i.aggregator);
  }
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

  // ── token 体检(只在真有 token 时跑;不打印任何秘密内容)──────────────────────────────
  // 为什么:"token 值填错(带引号/换行、被截断、被撤销)"报的是 401/ENEEDAUTH,而"值对但发布要
  // 一次性口令"报的是 **EOTP** —— 两者在 CI 日志里看着都像"发布失败",不查清楚就只能猜。
  // 这里只报长度与形状 + 用 `npm whoami` 验证能不能认证(输出用户名,不输出 token)。
  // dry-run 也跑:这样维护者能在**真发布之前**先确认工作区 .npmrc 里那份凭据是对的。
  if (NPMRC_ARGS.length > 0) {
    let token = null;
    try {
      const hit = /_authToken\s*=\s*(\S+)/.exec(readFileSync(WORKSPACE_NPMRC, 'utf8'));
      if (hit !== null) token = hit[1];
    } catch { /* 读不到就按"没有 token"处理 */ }
    if (token === null) {
      console.log(`[publish] token 体检:${relative(pkgRoot, WORKSPACE_NPMRC)} 里没有 _authToken 行`);
    } else {
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
      const shape = token.startsWith('npm_')
        ? 'npm_ 开头的 granular access token'
        : uuid ? 'UUID 形状的 classic token' : '⚠ 既不是 npm_ 开头、也不是 UUID 形状';
      console.log(`[publish] token 体检:长度 ${token.length},形状 = ${shape}(内容不打印)`);
      if (/^["']|["']$/.test(token)) {
        console.warn('[publish] ⚠ token 首尾带引号 ⇒ 多半复制时把引号也带上了,认证会失败');
      }
      const who = npm(['whoami'], pkgRoot);
      if (who.status === 0) {
        console.log('[publish] token 体检:✓ 认证通过(身份见上一行)。若随后发布仍失败,基本就是 EOTP:'
          + '① 该 token 没勾 "Bypass two-factor authentication (2FA)";'
          + '② 或这是这些包名的**首次发布**(npm 对首次发布本身要求 2FA)');
      } else {
        console.error(`[publish] token 体检:✗ npm whoami 失败(exit ${who.status})⇒ token 值不对/被撤销/`
          + '带引号或换行;请重新生成并粘贴(不要引号、不要末尾换行)');
      }
    }
  }

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
  if (failed > 0) {
    process.exitCode = 1;
    if (published === 0 && NPMRC_ARGS.length > 0) {
      console.error('[publish] 一个都没发成功、而且用的是 NPM_TOKEN ⇒ 最可能两条:'
        + '① token 没勾 "Bypass two-factor authentication (2FA)"(CI 里没人能输 OTP);'
        + '② 这些包名是**首次发布**,npm 对首次发布要求 2FA。'
        + '解法:本机 `npm publish <tgz> --access public --tag next` 带 OTP 首发一次(只发 5 个 -linux-* 的,'
        + '别重发已经存在的树包),然后给这些包名各加一条 Trusted Publisher,之后 CI 就能走 OIDC。');
    }
  }
  console.log('[publish] 提示:发布后 bump 插件版本并 `pnpm pack`,再 `dsh plugin --profile web add <tgz>`');
}

await main();
