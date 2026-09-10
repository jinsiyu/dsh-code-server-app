// scripts/vendor-vscode-server.mjs — 打包期准备「VS Code 树」(取代旧的 vendor-code-server.mjs 全量树)。
//
// 模型(重构后):
//   code-server 的 Node 服务层(out/node/**, 136 个依赖)不再随包发布 —— 它由插件自带的
//   lib/launcher.mjs 取代(见 docs/analysis-code-server-as-dsh-plugin.md)。本脚本只保留:
//     lib/vscode/**               已由 code-server 打过补丁的 VS Code server + 内置扩展(≈197MB)
//     out/browser/**              serviceWorker.js
//     src/browser/**              favicon / PWA 图标 / robots.txt
//     LICENSE, ThirdPartyNotices.txt
//   并生成树根 package.json(版本 = 上游 code-server 版本,便于版本比对)。
//
// 产物:
//   vendor/vscode/     本地开发树(--dev-links 时把 VS Code 内部依赖用 junction 补上,可直接跑)
//   vendor/VENDOR.json 版本与来源元数据
//
// 用法:
//   node scripts/vendor-vscode-server.mjs [--check] [--force]
//   node scripts/vendor-vscode-server.mjs --from <code-server 树>     # 从现有树复制(最快)
//   node scripts/vendor-vscode-server.mjs --version 4.136.2           # 从 registry 安装
//   node scripts/vendor-vscode-server.mjs --dev-links                 # 额外补 lib/vscode/node_modules
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const vendorDir = join(pkgRoot, 'vendor');
const vendorTree = join(vendorDir, 'vscode');
const legacyTree = join(vendorDir, 'code-server'); // 旧全量树(回退用,不再生成)
const workRoot = join(pkgRoot, '.vendor-tmp');
const npmCache = join(pkgRoot, '.npm-cache');

function argValues(name) {
  const out = [];
  for (let i = 0; i < process.argv.length - 1; i += 1) {
    if (process.argv[i] !== name) continue;
    for (const part of String(process.argv[i + 1]).split(',')) {
      const v = part.trim();
      if (v !== '') out.push(v);
    }
  }
  return out;
}
function argValue(name) {
  const all = argValues(name);
  return all.length > 0 ? all[all.length - 1] : null;
}
const FORCE = process.argv.includes('--force');
const DEV_LINKS = process.argv.includes('--dev-links');
const FROM = argValue('--from');
const PINNED = argValue('--version') || process.env.DSHCS_CODE_SERVER_VERSION || null;

function run(cmd, args, cwd, extraEnv) {
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  console.log(`[vendor] $ ${cmd} ${args.join(' ')}${cwd ? `  (cwd=${cwd})` : ''}`);
  const res = spawnSync(cmd, args, {
    cwd, stdio: 'inherit', shell: useShell,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${res.status})`);
}

function npm(args, cwd) {
  const env = { npm_config_cache: npmCache, npm_config_update_notifier: 'false' };
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) run(process.execPath, [cli, ...args], cwd, env);
  else run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd, env);
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

async function latestVersion() {
  const res = await fetch('https://registry.npmjs.org/code-server/latest');
  if (!res.ok) throw new Error(`registry responded ${res.status}`);
  const json = await res.json();
  if (typeof json.version !== 'string') throw new Error('registry payload has no version');
  return json.version;
}

function sizeMB(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) { try { total += statSync(full).size; } catch { /* ignore */ } }
    }
  }
  return Math.round((total / 1024 / 1024) * 10) / 10;
}

/** 默认源树:已安装 profile 里最新的 dshcs-code-server 树 → 旧 vendor 树。 */
function defaultSourceTree() {
  const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE ?? homedir(), '.dsh');
  const profiles = join(dshHome, 'profiles');
  const cands = [];
  try {
    for (const name of readdirSync(profiles)) {
      cands.push(join(profiles, name, 'node_modules', '@jinsiyu', 'dshcs-code-server', 'code-server'));
    }
  } catch { /* ignore */ }
  cands.push(legacyTree);
  for (const c of cands) if (existsSync(join(c, 'lib', 'vscode', 'out', 'server-main.js'))) return c;
  return null;
}

/** 复制策略:只留服务 IDE 必需的部分。
 *  keep: lib/vscode/**、out/browser/**、src/browser/**(除 pages)、LICENSE、ThirdPartyNotices.txt、README.md
 *  排除: node_modules/**、out/node/**、out/common/**、src/browser/pages/**、lib/vscode/(extensions/)node_modules/** */
function copySlim(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const dropDirs = [
    'node_modules',
    join('out', 'node'),
    join('out', 'common'),
    join('src', 'browser', 'pages'),
    join('lib', 'vscode', 'node_modules'),
    join('lib', 'vscode', 'extensions', 'node_modules'),
  ].map((p) => p.replaceAll('\\', '/'));
  const keepFiles = new Set(['LICENSE', 'ThirdPartyNotices.txt', 'README.md']);
  const keepRootDirs = new Set(['lib', 'out', 'src']);
  cpSync(src, dest, {
    recursive: true,
    dereference: false,
    maxRetries: 6,
    retryDelay: 250,
    filter: (source) => {
      const rel = source.slice(src.length + 1).replaceAll('\\', '/');
      if (rel === '') return true;
      if (dropDirs.some((d) => rel === d || rel.startsWith(`${d}/`))) return false;
      const top = rel.split('/')[0];
      if (rel.includes('/')) return keepRootDirs.has(top);
      return keepRootDirs.has(top) || keepFiles.has(top);
    },
  });
}

/** 把源树的 VS Code 内部依赖 junction 复刻到目标树(开发期直接可跑用)。
 *  必须用 type:'junction'(Windows 下 symlink 需要权限,cpSync 复制链接会 EPERM)。 */
function linkInnerDeps(srcTree, destTree) {
  const pairs = [
    [join('lib', 'vscode', 'node_modules'), join('lib', 'vscode', 'package.json')],
    [join('lib', 'vscode', 'extensions', 'node_modules'), join('lib', 'vscode', 'extensions', 'package.json')],
  ];
  let linked = 0;
  const failed = [];
  for (const [relNm] of pairs) {
    const srcNm = join(srcTree, relNm);
    const dstNm = join(destTree, relNm);
    if (!existsSync(srcNm)) continue;
    mkdirSync(dstNm, { recursive: true });
    const entries = [];
    for (const ent of readdirSync(srcNm, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      if (ent.isDirectory() && ent.name.startsWith('@')) {
        for (const sub of readdirSync(join(srcNm, ent.name), { withFileTypes: true })) {
          if (sub.name.startsWith('.')) continue;
          entries.push(`${ent.name}/${sub.name}`);
        }
      } else {
        entries.push(ent.name);
      }
    }
    for (const name of entries) {
      const from = join(srcNm, name);
      const to = join(dstNm, name);
      let target = from;
      try { if (lstatSync(from).isSymbolicLink()) target = readlinkSync(from); } catch { /* use as-is */ }
      try {
        mkdirSync(dirname(to), { recursive: true });
        rmSync(to, { recursive: true, force: true });
        symlinkSync(target, to, 'junction');
        linked += 1;
      } catch (error) {
        failed.push(`${name}: ${error.code ?? error.message}`);
      }
    }
  }
  return { linked, failed };
}

async function main() {
  const existing = readJson(join(vendorTree, 'package.json'))?.version ?? null;

  if (process.argv.includes('--check')) {
    const latest = await latestVersion();
    console.log(`[vendor] 内置 VS Code 树: ${existing ?? '(无)'} | 上游 code-server latest: ${latest}`);
    console.log(existing === latest ? '[vendor] 已是最新' : '[vendor] 有新版本:pnpm run vendor:latest → repack:build → publish:repacks → 版本 +1 → pnpm pack');
    return;
  }

  const skip = existing !== null && !FORCE && FROM === null && PINNED === null;
  let codeServerVersion = existing;
  let sourceKind = 'registry';
  let sourceTree = null;

  if (skip) {
    console.log(`[vendor] vendor/vscode 已存在(code-server@${existing});跳过(用 --force 重建)`);
  } else if (FROM !== null || (sourceTree = defaultSourceTree()) !== null) {
    const src = FROM ?? sourceTree;
    codeServerVersion = readJson(join(src, 'package.json'))?.version ?? null;
    if (codeServerVersion === null) throw new Error(`--from ${src} 不是一棵 code-server 树`);
    console.log(`[vendor] 源树 ${src}(code-server@${codeServerVersion})→ vendor/vscode/`);
    copySlim(src, vendorTree);
    sourceKind = FROM !== null ? `snapshot:${src}` : `local:${src}`;
  } else {
    codeServerVersion = PINNED ?? await latestVersion();
    console.log(`[vendor] 从 registry 准备 code-server@${codeServerVersion} …`);
    const tmp = join(workRoot, `source-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    try {
      npm(['install', `code-server@${codeServerVersion}`, '--ignore-scripts', '--omit=dev',
        '--no-audit', '--no-fund', '--no-save', '--prefix', tmp], tmp);
      const tree = join(tmp, 'node_modules', 'code-server');
      if (!existsSync(join(tree, 'lib', 'vscode', 'out', 'server-main.js'))) throw new Error('code-server 安装不完整');
      copySlim(tree, vendorTree);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const vscodePkg = readJson(join(vendorTree, 'lib', 'vscode', 'package.json')) ?? {};
  const product = readJson(join(vendorTree, 'lib', 'vscode', 'product.json')) ?? {};
  const productPath = `${product.quality ?? 'oss'}-${product.commit ?? 'dev'}`;
  const layout = { name: 'dshcs-vscode-tree', private: true, version: codeServerVersion };
  layout.vscodeVersion = vscodePkg.version ?? null;
  layout.productPath = productPath;
  writeFileSync(join(vendorTree, 'package.json'), JSON.stringify(layout, null, 2) + '\n', 'utf8');
  writeFileSync(join(vendorTree, 'VENDOR-TREE.json'), JSON.stringify({
    codeServerVersion,
    vscodeVersion: vscodePkg.version ?? null,
    productPath,
    preparedAt: new Date().toISOString(),
    source: sourceKind,
  }, null, 2) + '\n', 'utf8');

  let links = { linked: 0, failed: [] };
  if (DEV_LINKS) {
    const src = FROM ?? defaultSourceTree();
    if (src === null) console.warn('[vendor] --dev-links: 找不到可复刻 junction 的源树,跳过');
    else {
      links = linkInnerDeps(src, vendorTree);
      console.log(`[vendor] dev: 补 VS Code 内部依赖 junction ${links.linked} 个${links.failed.length > 0 ? `(失败 ${links.failed.length}: ${links.failed.slice(0, 5).join(', ')})` : ''}`);
    }
  }

  const meta = {
    codeServerVersion,
    vscodeVersion: vscodePkg.version ?? null,
    productPath,
    layout: 'vscode-only',
    preparedAt: new Date().toISOString(),
    source: sourceKind,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    sizeMB: sizeMB(vendorTree),
  };
  writeFileSync(join(vendorDir, 'VENDOR.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  console.log(`[vendor] 完成:vendor/vscode (code-server@${codeServerVersion}, VS Code ${meta.vscodeVersion}, ${meta.sizeMB} MB, productPath=${productPath})`);
  if (!DEV_LINKS) {
    console.log('[vendor] 提示:本树不含 VS Code 内部依赖;运行时由 lib/native.js 的 ensureRuntimeLayout() 补 junction'
      + '(开发期可直接 `--dev-links` 复刻)。');
  }
}

await main();
