// scripts/vendor-repacks.mjs — 打包期把「pnpm 拒绝安装」的包重打包成可安装的预编译包。
//
// 为什么:pnpm 认为「含安装脚本」或「含 binding.gyp / .hooks」的包需要构建,必须由宿主
// pnpm-workspace.yaml 的 allowBuilds 批准,否则 dsh plugin add 直接 exit 1。VS Code 内部
// 依赖里有一批这样的包(含原生模块),既不能在 profile 里声明为依赖,也不能靠 pnpm 装。
//
// 做法(实测可行,见下):
//   1. 从一棵**已完整安装**的 code-server 树出发,算出 needsRepack 闭包(带构建信号,以及依赖链
//      上命中它们的包 —— 含 optionalDependencies,例如 @vscode/proxy-agent → @vscode/windows-ca-certs);
//   2. 每个命中包重新打包成 @<scope>/dshcs-<名字>:
//        - 删掉全部 scripts / files 字段、binding.gyp、.hooks、.npmignore(全量打包,保住 build/*.node);
//        - 依赖里命中重打包集的,改成 npm: 别名;
//        - 含「非 prebuilds 的 .node」的包视为平台专属 → 名字带 -<platform>-<arch>,并写入 os/cpu;
//   3. 生成平台聚合包 @<scope>/dsh-code-server-runtime-<platform>-<arch>,dependencies 用 npm: 别名
//      把重打包包装回**原始名字**(node-pty / @vscode/sqlite3 / …),这样 VS Code 的 require 不用改;
//   4. 把「纯 JS 直装集」写进插件 package.json 的 dependencies,把两个平台聚合包写进 optionalDependencies。
//
// 结果:pnpm install 不再遇到任何带构建信号的包 → 无需 allowBuilds、无需「安装环境」步骤。
//
// 用法:
//   node scripts/vendor-repacks.mjs [--from <已完整安装的 code-server 树>] \
//        [--target win32-arm64,win32-x64] [--scope @jinsiyu] [--pack]
//   不给 --from 时自动准备源树(按 vendor/VENDOR.json 的版本 npm install --ignore-scripts,
//   再在 lib/vscode 里解包 + rebuild;耗时且需要工具链,维护者换版本时用)。
//   --pack 会用 npm pack 生成 repack/tgz/*.tgz(随后用 scripts/publish-repacks.mjs 发布)。
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
 *  @returns {string} 源树根 */
function prepareSourceTree() {
  const vendorVersion = readJson(join(pkgRoot, 'vendor', 'VENDOR.json'))?.codeServerVersion
    ?? readJson(join(pkgRoot, 'vendor', 'code-server', 'package.json'))?.version;
  if (typeof vendorVersion !== 'string' || vendorVersion === '') {
    throw new Error('缺少 vendor/code-server;先运行 `node scripts/vendor-code-server.mjs`');
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

function main() {
  const autoSource = FROM === null;
  const sourceTree = autoSource ? prepareSourceTree() : FROM;
  const hostKey = `${process.platform}-${process.arch}`;
  const targets = TARGETS.length > 0 ? TARGETS : [hostKey];
  const pluginVersion = readJson(join(pkgRoot, 'package.json'))?.version ?? '0.0.0';

  const { repack, declare } = analyze(sourceTree);
  console.log(`\n重打包集(${repack.size}):`);
  for (const [name, r] of [...repack].sort()) {
    console.log(`  ${name}@${r.pkg.version} ${r.platformSpecific ? '[平台专属]' : '[全平台]'}`);
  }
  console.log(`\n直装集(${declare.length}): ${declare.map((d) => d.name).join(', ')}\n`);

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

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
  for (const [name, r] of repack) {
    if (r.platformSpecific) continue; // 平台专属的按目标处理
    const dir = writeRepack(r.dir, hostMap.get(name), flat(name));
    plan.push({ dir, file: tgzName(hostMap.get(name).pkgName, r.pkg.version) });
  }
  // 2) 平台专属包:host 用现成树,其它目标用交叉安装树
  for (const target of targets) {
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
      description: `Prebuilt native modules for code-server on ${target} (node-pty, @vscode/sqlite3, kerberos, …), `
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

  // 4) 改写插件 package.json 的依赖
  const pkgFile = join(pkgRoot, 'package.json');
  const pluginPkg = readJson(pkgFile);
  pluginPkg.dependencies = Object.fromEntries(declare.map((d) => [d.name, d.version]).sort(([a], [b]) => a.localeCompare(b)));
  pluginPkg.optionalDependencies = Object.fromEntries(targets
    .map((t) => [`${SCOPE}/dsh-code-server-runtime-${t}`, `^${pluginVersion}`]));
  writeFileSync(pkgFile, JSON.stringify(pluginPkg, null, 2) + '\n', 'utf8');
  console.log(`[repack] 已写入 package.json:dependencies ${declare.length} 个(纯 JS),optionalDependencies ${targets.length} 个平台聚合包`);

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

  if (autoSource) {
    rmSync(sourceTree, { recursive: true, force: true });
    console.log('[repack] 已清理自动准备的源树');
  }
}

main();
