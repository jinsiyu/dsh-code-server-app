// scripts/vendor-code-server.mjs — 打包期准备插件包内置的 code-server 本体。
//
// 产物:
//   vendor/code-server/   code-server 本体 + 它自己的运行时依赖
//                         (npm install code-server@<v> --ignore-scripts;argon2 补齐原生二进制);
//                         **不含** VS Code 内部依赖(lib/vscode/node_modules,约 1GB),
//                         那部分由包管理器按依赖安装(见 scripts/vendor-repacks.mjs);
//   vendor/VENDOR.json    版本与来源元数据。
//
// 为什么 code-server 本体随包发布而不是写成依赖:pnpm 11 只接受宿主 profile 的构建许可,
// code-server / argon2 / unrs-resolver 带安装脚本 → 直接进 dependencies 会让
// `dsh plugin add` 报 [ERR_PNPM_IGNORED_BUILDS] exit 1。
//
// 用法:
//   node scripts/vendor-code-server.mjs --check                 # 只报告内置版本 vs npm 最新版
//   node scripts/vendor-code-server.mjs --force                 # 重建为 npm 最新版
//   node scripts/vendor-code-server.mjs --version 4.136.2       # 指定版本
//   node scripts/vendor-code-server.mjs --from <code-server 树>  # 从已准备好的树快照(最快)
//   DSHCS_ARGON2_BINARY=<argon2.node>                           # 编译不可用时复用已有原生二进制
//
// 换 code-server 版本后:还要重跑 `node scripts/vendor-repacks.mjs …` 更新预编译原生包,
// 再 `npm run publish:repacks` 发布,最后 bump 版本并 `pnpm pack`。
import { spawnSync } from 'node:child_process';
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const vendorDir = join(pkgRoot, 'vendor');
const vendorTree = join(vendorDir, 'code-server');
// 临时目录与 npm 缓存都放在工作区内:本机沙箱下 ~\AppData\Local\npm-cache 不可写(EPERM)。
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
const FROM = argValue('--from');
const PINNED = argValue('--version') || process.env.DSHCS_CODE_SERVER_VERSION || null;

function run(cmd, args, cwd, extraEnv) {
  // 只有 .cmd/.bat 需要 shell;node.exe 走 shell 会因路径带空格被 cmd 拆开(实测)。
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  console.log(`[vendor] $ ${cmd} ${args.join(' ')}${cwd ? `  (cwd=${cwd})` : ''}`);
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: useShell,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${res.status})`);
}

/** npm 优先直调 npm-cli.js(避免 shell 引号问题);找不到再回退 npm.cmd。 */
function npm(args, cwd) {
  const env = { npm_config_cache: npmCache, npm_config_update_notifier: 'false' };
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) run(process.execPath, [cli, ...args], cwd, env);
  else run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd, env);
}

async function latestVersion() {
  const res = await fetch('https://registry.npmjs.org/code-server/latest');
  if (!res.ok) throw new Error(`registry responded ${res.status}`);
  const json = await res.json();
  if (typeof json.version !== 'string') throw new Error('registry payload has no version');
  return json.version;
}

function readManifest(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
function readTreeVersion(tree) {
  const m = readManifest(join(tree, 'package.json'));
  return m !== null && typeof m.version === 'string' ? m.version : null;
}

/** 递归目录体积(MB),仅用于日志。 */
function sizeMB(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (ent.isDirectory()) stack.push(join(cur, ent.name));
      else if (ent.isFile()) { try { total += statSync(join(cur, ent.name)).size; } catch { /* ignore */ } }
    }
  }
  return Math.round((total / 1024 / 1024) * 10) / 10;
}

/** 补齐 code-server 自己的 argon2 native(win32-arm64 无预编译)。 */
function ensureArgon2(tree) {
  const argon2 = join(tree, 'node_modules', 'argon2');
  if (!existsSync(argon2)) return;
  const probe = probeArgon2(argon2);
  if (probe.ok) {
    console.log(`[vendor] argon2 native 就绪(${probe.via})`);
    return;
  }
  let built = false;
  const ngb = findNgb(tree);
  if (ngb !== null) {
    try {
      console.log(`[vendor] argon2 native 缺失(${probe.error}),执行 node-gyp-build…`);
      run(process.execPath, [ngb, argon2], tree);
      built = probeArgon2(argon2).ok;
    } catch (e) {
      console.warn(`[vendor] node-gyp-build 失败:${e.message}`);
    }
  }
  if (!built) {
    const bin = findArgon2Binary();
    if (bin === null) {
      throw new Error('argon2 native 不可用:编译失败且未找到可复用二进制'
        + '(可在有工具链的机器上重跑,或用 DSHCS_ARGON2_BINARY 指定 argon2.node)');
    }
    const dst = join(argon2, 'build', 'Release');
    rmSync(join(argon2, 'build'), { recursive: true, force: true });
    mkdirSync(dst, { recursive: true });
    copyFileSync(bin, join(dst, 'argon2.node'));
    console.log(`[vendor] argon2 native ← 复用 ${bin}`);
  }
}

/** 可复用的 argon2.node:环境变量 → 本机 DSH profile 里已装好的安装 → 插件包内既有产物。 */
function findArgon2Binary() {
  const cands = [];
  if (typeof process.env.DSHCS_ARGON2_BINARY === 'string' && process.env.DSHCS_ARGON2_BINARY !== '') {
    cands.push(process.env.DSHCS_ARGON2_BINARY);
  }
  try {
    const profiles = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles');
    if (existsSync(profiles)) {
      for (const name of readdirSync(profiles)) {
        // 0.1.35 及更早的安装位
        cands.push(join(profiles, name, '.code-server-app', 'node_modules', 'code-server',
          'node_modules', 'argon2', 'build', 'Release', 'argon2.node'));
        // 0.1.36+ 就地安装位
        cands.push(join(profiles, name, 'node_modules', 'dsh-code-server-app', 'vendor', 'code-server',
          'node_modules', 'argon2', 'build', 'Release', 'argon2.node'));
      }
    }
  } catch { /* ignore */ }
  cands.push(join(vendorTree, 'node_modules', 'argon2', 'build', 'Release', 'argon2.node'));
  cands.push(join(pkgRoot, 'node_modules', 'code-server', 'node_modules', 'argon2', 'build', 'Release', 'argon2.node'));
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

function findNgb(tree) {
  const cands = [
    join(tree, 'node_modules', 'node-gyp-build', 'bin.js'),
    join(tree, 'node_modules', 'argon2', 'node_modules', 'node-gyp-build', 'bin.js'),
  ];
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

function probeArgon2(dir) {
  const via = [];
  if (existsSync(join(dir, 'build', 'Release', 'argon2.node'))) via.push('build/Release');
  const want = `${process.platform}-${process.arch}`;
  if (existsSync(join(dir, 'prebuilds', want))) via.push(`prebuilds/${want}`);
  if (via.length > 0) return { ok: true, via: via.join('+') };
  // 不 require:argon2 的 index.js 会触发 node-gyp-build 现场编译(慢且可能失败)。
  return { ok: false, error: `无 build/Release 也无 prebuilds/${want}` };
}

/** 去掉 vendored 包里的安装脚本(pnpm/npm 不读它们,但避免后人误以为会执行)。 */
function stripInstallScripts(tree) {
  const targets = [
    join(tree, 'package.json'),
    join(tree, 'node_modules', 'argon2', 'package.json'),
    join(tree, 'node_modules', 'unrs-resolver', 'package.json'),
  ];
  for (const file of targets) {
    if (!existsSync(file)) continue;
    try {
      const manifest = readManifest(file);
      if (manifest !== null && manifest.scripts
        && (manifest.scripts.preinstall || manifest.scripts.install || manifest.scripts.postinstall)) {
        delete manifest.scripts.preinstall;
        delete manifest.scripts.install;
        delete manifest.scripts.postinstall;
        writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        console.log(`[vendor] 已剥离安装脚本: ${manifest.name}`);
      }
    } catch (e) {
      console.warn(`[vendor] 剥离脚本失败(${file}): ${e.message}`);
    }
  }
}

/** 复制 code-server 本体到 vendor/code-server;跳过 VS Code 内部依赖目录(不进主包)。 */
function copyCodeServer(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  const inner = [
    join('lib', 'vscode', 'node_modules'),
    join('lib', 'vscode', 'extensions', 'node_modules'),
  ].map((p) => p.replaceAll('\\', '/'));
  cpSync(src, dest, {
    recursive: true,
    dereference: false,
    maxRetries: 6,
    retryDelay: 250,
    filter: (source) => {
      const rel = source.slice(src.length + 1).replaceAll('\\', '/');
      return !inner.some((p) => rel === p || rel.startsWith(p + '/'));
    },
  });
}

async function main() {
  const existing = readTreeVersion(vendorTree);

  // --check:只报告内置版本 vs npm 最新版,不改任何东西。
  if (process.argv.includes('--check')) {
    const latest = await latestVersion();
    console.log(`[vendor] 内置 code-server: ${existing ?? '(无)'} | npm latest: ${latest}`);
    console.log(existing === latest
      ? '[vendor] 已是最新,无需重建'
      : '[vendor] 有新版本:pnpm run vendor:latest → node scripts/vendor-repacks.mjs → pnpm run publish:repacks → 版本 +1 后 pnpm pack');
    return;
  }

  const upToDate = existing !== null && !FORCE && FROM === null && PINNED === null;
  let codeServerVersion = existing;
  let sourceKind = 'registry';

  if (upToDate) {
    console.log(`[vendor] vendor/code-server 已存在(code-server@${existing});跳过(用 --force 重建)`);
  } else if (FROM !== null) {
    codeServerVersion = readTreeVersion(FROM);
    if (codeServerVersion === null) throw new Error(`--from ${FROM} 不是一棵 code-server 树`);
    console.log(`[vendor] 快照 ${FROM} → vendor/code-server (code-server@${codeServerVersion})`);
    // 只在副本上补 argon2 / 剥脚本,不改动源树(--from 常常指向正在使用的安装)。
    copyCodeServer(FROM, vendorTree);
    ensureArgon2(vendorTree);
    stripInstallScripts(vendorTree);
    sourceKind = `snapshot:${FROM}`;
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
      if (!existsSync(join(tree, 'out', 'node', 'entry.js'))) throw new Error('code-server 安装不完整');
      ensureArgon2(tree);
      stripInstallScripts(tree);
      copyCodeServer(tree, vendorTree);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const meta = {
    codeServerVersion,
    preparedAt: new Date().toISOString(),
    source: sourceKind,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    sizeMB: sizeMB(vendorTree),
  };
  writeFileSync(join(vendorDir, 'VENDOR.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  console.log(`[vendor] 完成:vendor/code-server (code-server@${codeServerVersion}, ${meta.sizeMB} MB) + vendor/VENDOR.json`);
  console.log('[vendor] 提示:VS Code 内部依赖由包管理器安装;换版本后请重跑 scripts/vendor-repacks.mjs 更新预编译原生包');
}

await main();
