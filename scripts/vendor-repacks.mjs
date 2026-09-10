// scripts/vendor-repacks.mjs — 打包期把「VS Code 树」与「pnpm 拒绝安装」的原生包打成可安装的预编译包。
//
// 为什么:pnpm 认为「含安装脚本」或「含 binding.gyp / .hooks」的包需要构建,必须由宿主
// pnpm-workspace.yaml 的 allowBuilds 批准,否则 dsh plugin add 直接 exit 1;VS Code 内部依赖里的一批
// 原生包都属于这一类。树本身则因为 npm 打包永远排除**包根** node_modules 而必须重打包。
//
// 产物(全部由本脚本生成,再由 scripts/publish-repacks.mjs 发布):
//   ① @<scope>/dshcs-vscode-server@<code-server 版本>  vendor/vscode 的树(lib/vscode + out/browser
//      + src/browser),不含 code-server 的 out/node 与它的 136 个依赖(那层由 lib/launcher.mjs 取代);
//   ② @<scope>/dshcs-<名字>[-<platform>-<arch>]@<版本>  需要构建的原生包(node-pty / @vscode/sqlite3 /
//      kerberos / koffi / ssh2 / …),依赖链上命中它们的包也一并重打包(含 optionalDependencies);
//   ③ @<scope>/dsh-code-server-runtime-<platform>-<arch>@<插件版本>  平台聚合包:用 npm: 别名把 ② 装回
//      原始名字,VS Code 的 require/import 无需改动;插件按 os/cpu 声明 ①(常规)+ ③(可选)依赖。
//
// 用法:node scripts/vendor-repacks.mjs [--from <已完整安装的 code-server 树>]
//        [--target win32-arm64,win32-x64] [--scope @jinsiyu] [--pack]
//   不给 --from 时自动准备源树(按 vendor/VENDOR.json 的版本 npm install --ignore-scripts,再在
//   lib/vscode 里解包 + rebuild;耗时且需要工具链,维护者换版本时用)。--pack 生成 repack/tgz/*.tgz。
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const OUT = join(pkgRoot, 'repack');
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
const argValue = (n) => { const a = argValues(n); return a.length > 0 ? a[a.length - 1] : null; };
const FROM = argValue('--from');
const SCOPE = argValue('--scope') ?? '@jinsiyu';
const DO_PACK = process.argv.includes('--pack');
// --reuse:复用 repack/build 里已有的原生包(不重新 analyze/交叉编译),只重建
//          VS Code 树包、平台聚合包与插件 package.json。
//          适用于「原生包没变、只调整打包结构」的场景(本机已无可分析的完整源树时也用它)。
const REUSE = process.argv.includes('--reuse');
const TARGETS = argValues('--target');
// Copilot 整树排除:620MB、依赖链里还有带脚本的包,且 code-server 里用不到。
const EXCLUDE = [/^@github\//, /^@vscode\/copilot-api$/];

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const flat = (n) => n.replace(/^@/, '').replaceAll('/', '-');
const excluded = (n) => EXCLUDE.some((re) => re.test(n));
const tgzName = (pkgName, version) => `${flat(pkgName)}-${version}.tgz`;

function run(cmd, args, cwd, env) {
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: useShell, env: { ...process.env, ...env } });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${res.status})`);
}
function npm(args, cwd) {
  const env = { npm_config_cache: npmCache, npm_config_update_notifier: 'false' };
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) run(process.execPath, [cli, ...args], cwd, env);
  else run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd, env);
}

/** 收集树里的所有包(顶层 + 嵌套)。 */
function collect(dir, out = new Map(), depth = 0) {
  if (depth > 5 || !existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name === '.bin' || ent.name === '.cache') continue;
    const full = join(dir, ent.name);
    if (ent.name.startsWith('@')) { collect(full, out, depth + 1); continue; }
    const m = readJson(join(full, 'package.json'));
    if (m === null) { collect(full, out, depth + 1); continue; }
    out.set(full, { dir: full, name: m.name, version: m.version, manifest: m });
    const nested = join(full, 'node_modules');
    if (existsSync(nested)) collect(nested, out, depth + 1);
  }
  return out;
}
function resolveDep(fromDir, depName) {
  let cur = fromDir;
  for (let i = 0; i < 6; i += 1) {
    const cand = join(cur, 'node_modules', depName, 'package.json');
    if (existsSync(cand)) return dirname(cand);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}
function hasBuildSignal(pkg) {
  const s = pkg.manifest.scripts ?? {};
  if (s.preinstall || s.install || s.postinstall) return true;
  return existsSync(join(pkg.dir, 'binding.gyp')) || existsSync(join(pkg.dir, '.hooks'));
}
function isPlatformSpecific(pkg) {
  const stack = [pkg.dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries; try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(cur, e.name);
      const rel = relative(pkg.dir, full).replaceAll('\\', '/');
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || rel === 'prebuilds' || rel.startsWith('prebuilds/')) continue;
        stack.push(full);
      } else if (e.name.endsWith('.node') && !rel.startsWith('prebuilds/')) return true;
    }
  }
  return false;
}

/** 分析一棵树:返回 { repack: Map(name -> {dir,pkg,platformSpecific}), declare: [{name,version}] }。 */
function analyze(tree) {
  const VS = join(tree, 'lib', 'vscode');
  const packages = collect(join(VS, 'node_modules'));
  const vsManifest = readJson(join(VS, 'package.json'));
  const memo = new Map();
  function needsRepack(dir) {
    if (memo.has(dir)) return memo.get(dir);
    memo.set(dir, false); // 防环
    const pkg = packages.get(dir);
    if (!pkg || excluded(pkg.name)) return false;
    let result = hasBuildSignal(pkg);
    if (!result) {
      const deps = { ...(pkg.manifest.dependencies ?? {}), ...(pkg.manifest.optionalDependencies ?? {}) };
      for (const depName of Object.keys(deps)) {
        if (excluded(depName)) continue;
        const d = resolveDep(pkg.dir, depName);
        if (d !== null && needsRepack(d)) { result = true; break; }
      }
    }
    memo.set(dir, result);
    return result;
  }

  const repack = new Map();
  const declare = [];
  for (const name of Object.keys(vsManifest.dependencies ?? {})) {
    if (excluded(name)) { console.log(`  [排除 Copilot] ${name}`); continue; }
    const dir = resolveDep(VS, name);
    if (dir === null) { console.warn(`  ⚠ 找不到 ${name}`); continue; }
    if (needsRepack(dir)) {
      const pkg = packages.get(dir);
      repack.set(name, { dir, pkg, platformSpecific: isPlatformSpecific(pkg) });
    } else {
      declare.push({ name, version: packages.get(dir).version });
    }
  }
  for (const [dir, pkg] of packages) {
    if (excluded(pkg.name) || repack.has(pkg.name)) continue;
    if (needsRepack(dir)) repack.set(pkg.name, { dir, pkg, platformSpecific: isPlatformSpecific(pkg) });
  }
  const extNm = join(VS, 'extensions', 'node_modules');
  for (const ent of (existsSync(extNm) ? readdirSync(extNm, { withFileTypes: true }) : [])) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const m = readJson(join(ent.isDirectory() ? join(extNm, ent.name) : '', 'package.json'));
    if (m !== null) declare.push({ name: m.name, version: m.version });
  }
  return { repack, declare };
}

/** 该架构是否装了 MSVC 的 Spectre 缓解库(lib\spectre\<arch>)。
 *  VS Code 的 @vscode/* 原生包在 binding.gyp 里写死 SpectreMitigation: Spectre,
 *  缺库时 MSBuild 直接报 MSB8040(此机只装了 arm64/arm64ec)。 */
function spectreLibsFor(arch) {
  for (const root of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean)) {
    const vsRoot = join(root, 'Microsoft Visual Studio');
    if (!existsSync(vsRoot)) continue;
    for (const ver of readdirSync(vsRoot)) {
      const verDir = join(vsRoot, ver);
      let editions; try { editions = readdirSync(verDir); } catch { continue; }
      for (const ed of editions) {
        const msvcRoot = join(verDir, ed, 'VC', 'Tools', 'MSVC');
        if (!existsSync(msvcRoot)) continue;
        for (const tools of readdirSync(msvcRoot)) {
          if (existsSync(join(msvcRoot, tools, 'lib', 'spectre', arch))) return true;
        }
      }
    }
  }
  return false;
}

/** 把树里所有 *.gyp / *.gypi 的 SpectreMitigation 降级为 false(仅关掉 Spectre 加固,不影响功能)。
 *  注意:除 binding.gyp 外,依赖自带的 deps/*.gyp 也会设它(如 @vscode/sqlite3/deps/sqlite3.gyp)。 */
function relaxSpectre(treeRoot) {
  let patched = 0;
  const stack = [treeRoot];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries; try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!/\.gypi?$/.test(e.name)) continue;
      const src = readFileSync(full, 'utf8');
      const out = src.replace(/(["']SpectreMitigation["']\s*:\s*)["']Spectre["']/g, '$1"false"');
      if (out !== src) { writeFileSync(full, out, 'utf8'); patched += 1; }
    }
  }
  return patched;
}

/** 列出某个包目录下的 .node 文件(跳过嵌套 node_modules)。 */
function nodeFilesOf(dir) {
  const nodes = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries; try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) { if (e.name !== 'node_modules') stack.push(join(cur, e.name)); }
      else if (e.name.endsWith('.node')) nodes.push(join(cur, e.name));
    }
  }
  return nodes;
}

/** 准备另一平台的一棵「只含平台专属包」的安装(用 --os/--cpu 拉取 + npm rebuild 交叉编译)。 */
function prepareCrossTree(specs, target) {
  const [platform, arch] = target.split('-');
  const tmp = join(pkgRoot, '.vendor-tmp', `cross-repack-${target}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'cross', private: true, version: '0.0.0' }, null, 2) + '\n', 'utf8');
  const names = specs.map((s) => `${s.name}@${s.version}`);
  console.log(`[repack] 拉取 ${target} 平台专属包(${names.length} 个)…`);
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save',
    `--os=${platform}`, `--cpu=${arch}`, ...names], tmp);
  console.log(`[repack] 交叉编译 ${target}: ${specs.map((s) => s.name).join(', ')}`);
  const buildOne = (spec) => {
    try {
      npm(['rebuild', `--arch=${arch}`, spec.name], tmp);
    } catch (e) {
      console.warn(`[repack] ${target}: ${spec.name} 编译失败(${e.message})`);
    }
    return nodeFilesOf(join(tmp, 'node_modules', spec.name)).length > 0;
  };
  const failed = [];
  let relaxed = false;
  for (const spec of specs) {
    if (!buildOne(spec)) failed.push(spec);
  }
  // 兜底:某些机器只装了部分架构的 Spectre 缓解库(MSB8040)→ 降级 gyp 后重试失败的包。
  if (failed.length > 0) {
    const n = relaxSpectre(join(tmp, 'node_modules'));
    relaxed = n > 0;
    console.log(`[repack] ${target}: ${failed.length} 个包未产出二进制 → 降级 ${n} 个 gyp 的 SpectreMitigation 后重试`);
    const retry = failed.splice(0, failed.length);
    for (const spec of retry) {
      if (!buildOne(spec)) failed.push(spec);
    }
  }
  for (const spec of specs) {
    const nodes = nodeFilesOf(join(tmp, 'node_modules', spec.name));
    if (nodes.length === 0) console.warn(`  ⚠ ${target}: ${spec.name} 未生成 .node 二进制`);
    else console.log(`  ✓ ${target}: ${spec.name} → ${nodes.map((p) => relative(tmp, p).replaceAll('\\', '/')).join(', ')}`);
  }
  if (relaxed) console.log(`[repack] ${target}: 注意——部分二进制未启用 Spectre 加固(该架构缺少缓解库)`);
  return tmp;
}

/** 没有 --from 时自动准备一棵「完整安装」的源树(维护者换 code-server 版本时用):
 *  1) npm install code-server@<内置版本> --ignore-scripts(只解包);
 *  2) 在 lib/vscode 与 lib/vscode/extensions 里 npm install --ignore-scripts(解包内部依赖,约 1GB);
 *  3) 缺 Spectre 库时先降级 gyp,再 npm rebuild(编译本机原生包)。
 *  注意:只有 lib/vscode 的依赖会被 analyze 用到 —— code-server 自己的 136 个依赖已随服务层移除。
 *  @returns {string} 源树根 */
function prepareSourceTree() {
  const vendorVersion = readJson(join(pkgRoot, 'vendor', 'vscode', 'package.json'))?.version
    ?? readJson(join(pkgRoot, 'vendor', 'code-server', 'package.json'))?.version;
  if (typeof vendorVersion !== 'string' || vendorVersion === '') {
    throw new Error('缺少 vendor/vscode;先运行 `node scripts/vendor-vscode-server.mjs`');
  }
  const tmp = join(pkgRoot, '.vendor-tmp', `repack-src-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  console.log(`[repack] 准备完整源树 code-server@${vendorVersion} → ${tmp}`);
  npm(['install', `code-server@${vendorVersion}`, '--ignore-scripts', '--omit=dev',
    '--no-audit', '--no-fund', '--no-save'], tmp);
  const tree = join(tmp, 'node_modules', 'code-server');
  const innerDirs = [join('lib', 'vscode'), join('lib', 'vscode', 'extensions')]
    .map((rel) => join(tree, rel))
    .filter((dir) => existsSync(join(dir, 'package.json')));
  for (const dir of innerDirs) {
    console.log(`[repack] 解包内部依赖(不执行脚本): ${relative(pkgRoot, dir)}`);
    npm(['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], dir);
  }
  if (!spectreLibsFor(process.arch)) {
    const n = relaxSpectre(tree);
    if (n > 0) console.log(`[repack] ${process.arch}: 未安装 Spectre 缓解库 → 已把 ${n} 个 gyp 的 SpectreMitigation 降级为 false`);
  }
  for (const dir of innerDirs) {
    if (!existsSync(join(dir, 'node_modules'))) continue;
    console.log(`[repack] 编译内部依赖原生包: ${relative(pkgRoot, dir)}`);
    try {
      npm(['rebuild'], dir);
    } catch (e) {
      console.warn(`[repack] ${relative(pkgRoot, dir)} rebuild 失败(${e.message});后续按缺失处理`);
    }
  }
  return tree;
}

/** PE machine(0x8664=x64 / 0xaa64=arm64),用于交叉编译后的静态校验。 */
function peMachine(file) {
  try {
    const b = readFileSync(file);
    if (b[0] !== 0x4d || b[1] !== 0x5a) return null;
    const off = b.readUInt32LE(0x3c);
    if (b.toString('ascii', off, off + 4) !== 'PE\u0000\u0000') return null;
    return `0x${b.readUInt16LE(off + 4).toString(16)}`;
  } catch { return null; }
}

/** ① VS Code 树(平台无关):vendor/vscode → repack/build/vscode/vscode/。
 *  排除 VS Code 的「内部依赖目录」(lib/vscode/node_modules、lib/vscode/extensions/node_modules)
 *  —— 它们由包管理器安装 + 平台聚合包按架构提供,树里只留 lib/vscode 本体与静态资源。
 *  不含 code-server 的 out/node 与服务层依赖(已由 lib/launcher.mjs 取代)。 */
function buildVscodeServerPackage() {
  const vendorTree = join(pkgRoot, 'vendor', 'vscode');
  if (!existsSync(join(vendorTree, 'lib', 'vscode', 'out', 'server-main.js'))) {
    throw new Error('缺少 vendor/vscode;先运行 `node scripts/vendor-vscode-server.mjs`');
  }
  const version = readJson(join(vendorTree, 'package.json'))?.version;
  if (typeof version !== 'string') throw new Error('读不到树版本(vendor/vscode/package.json)');
  const dir = join(OUT, 'build', 'vscode');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const inner = [
    join('lib', 'vscode', 'node_modules'),
    join('lib', 'vscode', 'extensions', 'node_modules'),
  ].map((p) => p.replaceAll('\\', '/'));
  console.log(`[repack] VS Code 树(平台无关)→ ${relative(pkgRoot, join(dir, 'vscode'))}`);
  cpSync(vendorTree, join(dir, 'vscode'), {
    recursive: true,
    dereference: false,
    maxRetries: 6,
    retryDelay: 250,
    filter: (source) => {
      const rel = source.slice(vendorTree.length + 1).replaceAll('\\', '/');
      return !inner.some((p) => rel === p || rel.startsWith(`${p}/`));
    },
  });
  const name = `${SCOPE}/dshcs-vscode-server`;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version,
    description: `The VS Code server tree from code-server ${version} (lib/vscode + browser assets), repacked so pnpm `
      + 'installs it without any build script. The code-server Node layer is replaced by the plugin launcher.',
    files: ['vscode'],
    license: 'MIT',
    repository: readJson(join(pkgRoot, 'package.json'))?.repository ?? undefined,
  }, null, 2) + '\n', 'utf8');
  return { dir, name, version, file: tgzName(name, version) };
}

/** 从已安装的 profile 的 node_modules 还原 host 平台映射(别名目录名 = 原始包名,清单名 = 重打包名)。
 *  聚合包清单丢失时的兜底(例如上次构建中途失败)。 */
function hostMapFromProfile() {
  const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');
  const profiles = join(dshHome, 'profiles');
  if (!existsSync(profiles)) return null;
  let best = null;
  let bestProfile = null;
  for (const name of readdirSync(profiles)) {
    const nm = join(profiles, name, 'node_modules');
    if (!existsSync(nm)) continue;
    const map = new Map();
    const visit = (dir, prefix) => {
      let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name === '.bin' || ent.name === '.pnpm') continue;
        const full = join(dir, ent.name);
        if (ent.name.startsWith('@')) { visit(full, prefix + ent.name + '/'); continue; }
        const m = readJson(join(full, 'package.json'));
        if (m === null || typeof m.name !== 'string') continue;
        // argon2 已随 code-server 服务层移除:旧 profile 的别名表里可能仍有它
        if (ent.name === 'argon2' || /dshcs-argon2/.test(m.name)) continue;
        if (!/^@[^/]+\/dshcs-/.test(m.name) || /dshcs-(code-server|vscode-server)/.test(m.name)) continue;
        map.set(`${prefix}${ent.name}`, { pkgName: m.name, version: m.version });
      }
    };
    visit(nm, '');
    if (map.size > 0 && (best === null || map.size > best.size)) { best = map; bestProfile = name; }
  }
  if (best !== null) {
    console.log(`[repack] --reuse:从 profile ${bestProfile} 的别名还原 ${best.size} 个映射`);
  }
  return best;
}

/** --reuse:从现有 repack/build + 聚合包清单还原「重打包集」,不重新分析源树。
 *  @returns {{repack: Map<string,{pkg:{version:string},platformSpecific:boolean}>, declare:{name:string,version:string}[], reusedItems:{dir:string,file:string}[]}} */
function reuseExisting(targets, hostKey) {
  const buildRoot = join(OUT, 'build');
  if (!existsSync(buildRoot)) throw new Error('--reuse 需要 repack/build 已存在(先跑一次完整流程)');
  const byTarget = new Map();
  for (const target of targets) {
    const agg = readJson(join(OUT, 'aggregator', target, 'package.json'));
    if (agg === null) continue;
    const map = new Map();
    for (const [orig, spec] of Object.entries(agg.dependencies ?? {})) {
      // 旧的聚合包清单里可能仍带 argon2(已随 code-server 服务层移除)
      if (orig === 'argon2') continue;
      const hit = /^npm:(.+)@([^@]+)$/.exec(spec);
      if (hit === null) throw new Error(`无法解析聚合包依赖 ${orig}: ${spec}`);
      map.set(orig, { pkgName: hit[1], version: hit[2] });
    }
    byTarget.set(target, map);
  }
  if (byTarget.size === 0) {
    const base = hostMapFromProfile();
    if (base === null) {
      throw new Error('--reuse 需要 repack/aggregator/*/package.json 或一个已安装的 profile 用于还原映射');
    }
    byTarget.set(hostKey, base);
  } else {
    // 与已安装 profile 的别名取并集:聚合包清单可能在上一次失败的重建里丢过条目
    const hostTarget = byTarget.has(hostKey) ? hostKey : targets[0];
    const base = hostMapFromProfile();
    if (base !== null) {
      const merged = new Map(byTarget.get(hostTarget));
      let added = 0;
      for (const [orig, info] of base) {
        if (!merged.has(orig)) { merged.set(orig, info); added += 1; }
      }
      if (added > 0) console.log(`[repack] --reuse:聚合包清单缺 ${added} 个条目 → 已用 profile 别名补齐`);
      byTarget.set(hostTarget, merged);
    }
  }
  const known = byTarget.get(hostKey) ?? byTarget.get(targets[0]);
  // 其余目标:按后缀替换推导(平台专属包名只在结尾的 -<platform>-<arch> 上不同)
  const knownTarget = byTarget.has(hostKey) ? hostKey : targets[0];
  for (const target of targets) {
    if (byTarget.has(target)) continue;
    const map = new Map();
    for (const [orig, info] of known) {
      const pkgName = info.pkgName.endsWith(`-${knownTarget}`)
        ? `${info.pkgName.slice(0, -knownTarget.length)}${target}`
        : info.pkgName;
      map.set(orig, { pkgName, version: info.version });
    }
    byTarget.set(target, map);
  }
  const hostSet = byTarget.get(knownTarget);
  const repack = new Map();
  for (const [orig, info] of hostSet) {
    repack.set(orig, { pkg: { version: info.version }, platformSpecific: info.pkgName.endsWith(`-${knownTarget}`) });
  }
  // 已有原生包目录 → plan 项;顺带清掉将被重建的树目录(旧 code-server / argon2 目录一并清理)
  const reusedItems = [];
  for (const ent of readdirSync(buildRoot)) {
    if (ent === 'vscode' || /^code-server/.test(ent) || /^argon2-/.test(ent)) {
      rmSync(join(buildRoot, ent), { recursive: true, force: true });
      continue;
    }
    const m = readJson(join(buildRoot, ent, 'package.json'));
    if (m === null) continue;
    reusedItems.push({ dir: join(buildRoot, ent), file: tgzName(m.name, m.version) });
  }
  // 纯 JS 直装集:插件现有 dependencies 里非 @jinsiyu 的项
  const pluginPkg = readJson(join(pkgRoot, 'package.json'));
  const declare = Object.entries(pluginPkg.dependencies ?? {})
    .filter(([name]) => !/^@jinsiyu\//.test(name))
    .map(([name, version]) => ({ name, version }));
  rmSync(join(OUT, 'aggregator'), { recursive: true, force: true });
  console.log(`[repack] --reuse:复用 ${reusedItems.length} 个已打包目录、${repack.size} 个重打包条目、${declare.length} 个纯 JS 直装依赖`);
  return { repack, declare, reusedItems };
}

function main() {
  const hostKey = `${process.platform}-${process.arch}`;
  const targets = TARGETS.length > 0 ? TARGETS : [hostKey];
  const pluginVersion = readJson(join(pkgRoot, 'package.json'))?.version ?? '0.0.0';

  let repack;
  let declare;
  let reusedItems = [];
  let autoSourceTree = null;
  if (REUSE) {
    ({ repack, declare, reusedItems } = reuseExisting(targets, hostKey));
  } else {
    const autoSource = FROM === null;
    const sourceTree = autoSource ? prepareSourceTree() : FROM;
    if (autoSource) autoSourceTree = sourceTree;
    ({ repack, declare } = analyze(sourceTree));
    rmSync(OUT, { recursive: true, force: true });
  }
  console.log(`\n重打包集(${repack.size}):`);
  for (const [name, r] of [...repack].sort()) {
    console.log(`  ${name}@${r.pkg.version} ${r.platformSpecific ? '[平台专属]' : '[全平台]'}`);
  }
  console.log(`\n直装集(${declare.length}): ${declare.map((d) => d.name).join(', ')}\n`);

  mkdirSync(join(OUT, 'build'), { recursive: true });

  // 每个目标的包名映射
  const byTarget = new Map();
  for (const target of targets) {
    const suffix = `-${target}`;
    const map = new Map(); // 原包名 -> { pkgName, version }
    for (const [name, r] of repack) {
      const pkgName = `${SCOPE}/dshcs-${flat(name)}${r.platformSpecific ? suffix : ''}`;
      map.set(name, { pkgName, version: r.pkg.version, platformSpecific: r.platformSpecific });
    }
    byTarget.set(target, map);
  }
  const hostMap = byTarget.get(hostKey) ?? byTarget.get(targets[0]);

  // 1) 全平台重打包包(从 host 树)
  const buildDir = join(OUT, 'build');
  const writeRepack = (srcDir, pkg, outName) => {
    const dir = join(buildDir, outName);
    mkdirSync(dirname(dir), { recursive: true });
    cpSync(srcDir, dir, { recursive: true, maxRetries: 6, retryDelay: 250 });
    rmSync(join(dir, 'binding.gyp'), { force: true });
    rmSync(join(dir, '.hooks'), { recursive: true, force: true });
    rmSync(join(dir, '.npmignore'), { force: true });
    const m = readJson(join(dir, 'package.json'));
    delete m.scripts;
    delete m.files;
    m.name = pkg.pkgName;
    m.version = pkg.version;
    if (pkg.platformSpecific) {
      const [platform, arch] = pkg.pkgName.match(/-(win32|darwin|linux)-(arm64|x64)$/).slice(1);
      m.os = [platform];
      m.cpu = [arch];
      if (platform === 'win32') {
        // 交叉编译产物静态校验:.node 的 PE machine 必须是目标架构(0x8664=x64 / 0xaa64=arm64)
        const want = arch === 'x64' ? '0x8664' : '0xaa64';
        const files = nodeFilesOf(dir);
        const wrong = files
          .map((file) => [file, peMachine(file)])
          .filter(([, machine]) => machine !== null && machine !== want);
        if (files.length > 0 && wrong.length === files.length) {
          throw new Error(`${pkg.pkgName}: 所有 .node 架构都不是 ${want}`
            + `(${wrong.map(([file, machine]) => `${relative(dir, file)}=${machine}`).join(', ')})`);
        }
        if (wrong.length > 0) {
          console.warn(`  ⚠ ${pkg.pkgName}: ${wrong.length} 个 .node 架构不符(期望 ${want})`);
        }
      }
    }
    for (const fld of ['dependencies', 'optionalDependencies']) {
      if (!m[fld]) continue;
      for (const depName of Object.keys(m[fld])) {
        const dep = hostMap.get(depName);
        if (dep) m[fld][depName] = `npm:${dep.pkgName}@${dep.version}`;
      }
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(m, null, 2) + '\n', 'utf8');
    return dir;
  };

  const plan = [];
  // 0) 已打包的原生包(--reuse 模式)
  for (const item of reusedItems) plan.push(item);
  // 1) VS Code 树(平台无关,1 个包)
  const vscodePkg = buildVscodeServerPackage();
  plan.push({ dir: vscodePkg.dir, file: vscodePkg.file });
  // 2) 全平台重打包包(从 host 树;--reuse 时用已打包目录)
  if (!REUSE) {
    for (const [name, r] of repack) {
      if (r.platformSpecific) continue; // 平台专属的按目标处理
      const dir = writeRepack(r.dir, hostMap.get(name), flat(name));
      plan.push({ dir, file: tgzName(hostMap.get(name).pkgName, r.pkg.version) });
    }
  }
  // 3) 平台专属包:host 用现成树,其它目标用交叉安装树(--reuse 时用已打包目录)
  if (!REUSE) for (const target of targets) {
    const map = byTarget.get(target);
    const specs = [...repack].filter(([, r]) => r.platformSpecific).map(([name, r]) => ({ name, version: r.pkg.version }));
    let crossTree = null;
    if (target !== hostKey && specs.length > 0) crossTree = prepareCrossTree(specs, target);
    for (const [name, r] of repack) {
      if (!r.platformSpecific) continue;
      const info = map.get(name);
      const srcDir = target === hostKey ? r.dir : join(crossTree, 'node_modules', name);
      if (!existsSync(join(srcDir, 'package.json'))) {
        console.warn(`  ⚠ ${target}: 缺少 ${name},跳过`);
        continue;
      }
      const dir = writeRepack(srcDir, info, `${flat(name)}-${target}`);
      plan.push({ dir, file: tgzName(info.pkgName, r.pkg.version) });
    }
    if (crossTree !== null) rmSync(crossTree, { recursive: true, force: true });
  }
  // 3) 聚合包(每平台一个):dependencies 用 npm: 别名把重打包包装回原名
  for (const target of targets) {
    const map = byTarget.get(target);
    const aggName = `${SCOPE}/dsh-code-server-runtime-${target}`;
    const aggDir = join(OUT, 'aggregator', target);
    mkdirSync(aggDir, { recursive: true });
    const deps = {};
    for (const [name] of repack) deps[name] = `npm:${map.get(name).pkgName}@${map.get(name).version}`;
    writeFileSync(join(aggDir, 'package.json'), JSON.stringify({
      name: aggName,
      version: pluginVersion,
      description: `Prebuilt native modules for the VS Code server tree on ${target} `
        + '(node-pty, @vscode/sqlite3, kerberos, @vscode/spdlog, …), '
        + 'so that installing the VS Code inner dependencies needs no build approval or C++ toolchain.',
      os: [target.split('-')[0]],
      cpu: [target.split('-')[1]],
      dependencies: deps,
      license: 'MIT',
      repository: readJson(join(pkgRoot, 'package.json'))?.repository ?? undefined,
    }, null, 2) + '\n', 'utf8');
    plan.push({ dir: aggDir, file: tgzName(aggName, pluginVersion), aggregator: true, target });
  }

  writeFileSync(join(OUT, 'pack-plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8');
  console.log(`[repack] 生成 ${plan.length} 个待打包目录 → repack/ (计划:repack/pack-plan.json)`);

  // 4) 改写插件 package.json 的依赖:纯 JS 直装集 + VS Code 树包(平台无关);
  //    平台专属的(原生包)通过聚合包按 os/cpu 自动选。
  const pkgFile = join(pkgRoot, 'package.json');
  const pluginPkg = readJson(pkgFile);
  pluginPkg.dependencies = Object.fromEntries([
    [vscodePkg.name, vscodePkg.version],
    ...declare.map((d) => [d.name, d.version]),
  ].sort(([a], [b]) => a.localeCompare(b)));
  pluginPkg.optionalDependencies = Object.fromEntries(targets
    .map((t) => [`${SCOPE}/dsh-code-server-runtime-${t}`, `^${pluginVersion}`]));
  writeFileSync(pkgFile, JSON.stringify(pluginPkg, null, 2) + '\n', 'utf8');
  console.log(`[repack] 已写入 package.json:dependencies ${pluginPkg.dependencies ? Object.keys(pluginPkg.dependencies).length : 0} 个`
    + `(VS Code 树 + 纯 JS),optionalDependencies ${targets.length} 个平台聚合包`);

  // 5) 可选:直接打包
  if (DO_PACK) {
    mkdirSync(join(OUT, 'tgz'), { recursive: true });
    for (const item of plan) {
      console.log(`[repack] npm pack ${item.file}`);
      npm(['pack', '--pack-destination', join(OUT, 'tgz')], item.dir);
    }
    console.log(`[repack] tarball → repack/tgz/`);
  } else {
    console.log('[repack] 未加 --pack;在普通终端里执行 `node scripts/vendor-repacks.mjs --pack` 生成 tarball');
  }

  if (autoSourceTree !== null) {
    rmSync(autoSourceTree, { recursive: true, force: true });
    console.log('[repack] 已清理自动准备的源树');
  }
}

main();
