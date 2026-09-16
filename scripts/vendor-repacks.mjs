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
//   ③ 插件依赖表 + lib/vendored.json —— **0.3.45 起不再有平台聚合包**:平台无关的重打包包写进插件
//      `dependencies`(真名),平台专属的写进 `optionalDependencies`(真名 + 包自带 os/cpu,每目标一份);
//      原始名字(node-pty / @vscode/sqlite3 …)由 lib/native.js 在运行时按 lib/vendored.json 补 junction。
//      为什么弃用「平台聚合包 + npm: 别名」:见 docs/desktop-first-install-root-cause.md。
//
// 用法:node scripts/vendor-repacks.mjs [--from <已完整安装的 code-server 树>]
//        [--target win32-arm64,win32-x64] [--scope @jinsiyu] [--pack]
//   不给 --from 时自动准备源树(按 vendor/VENDOR.json 的版本 npm install --ignore-scripts,再在
//   lib/vscode 里解包 + rebuild;耗时且需要工具链,维护者换版本时用)。--pack 生成 repack/tgz/*.tgz。
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
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
// --skip-independent:不重建「平台无关」的重打包包。平台无关的包**只由 win32-x64 那条腿产出并发布**
// (四个目标内容一致,不能四边都发同一个版本号),其它腿重建它们纯属浪费,而且会把一份"在别的宿主上
// 打出来的同名包"塞进 artifact —— 谁要是从 artifact 手工发布,发出去的就是错的内容。
const SKIP_INDEPENDENT = process.argv.includes('--skip-independent');
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
  // **必须显式 --prefix**:不给它时 npm 会往上找"最近的 package.json"当项目根 —— 而 tmp 就在
  // 仓库目录里面(<pkgRoot>/.vendor-tmp/repack-src-<pid>),于是包被装进 <pkgRoot>/node_modules,
  // 而下面按 <tmp>/node_modules/code-server 去找 ⇒ readJson() 拿到 null ⇒ analyze() 读
  // `.dependencies` 时直接 TypeError。2026-09-16 在 ubuntu-latest 上实测到:日志里连
  // 「解包内部依赖」都没有(innerDirs 是空的),因为树根本不在那儿。vendor-vscode-server.mjs
  // 的同一步带了 --prefix,所以那条路一直是对的 —— 这里补齐。
  npm(['install', `code-server@${vendorVersion}`, '--ignore-scripts', '--omit=dev',
    '--no-audit', '--no-fund', '--no-save', '--prefix', tmp], tmp);
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
    // ① 整树 rebuild 一次:覆盖声明里没登记的新包。失败不算错 —— 因为 npm 会在**第一个失败**处中断,
    //    一个包编不出来(例如 Windows 上缺 v145 工具集,或 Linux 上缺某个头文件)就会让它后面的包
    //    再也没轮到自己,于是"一个包失败"级联成"一批包没编出来"。
    try {
      npm(['rebuild'], dir);
    } catch (e) {
      console.warn(`[repack] 整树 rebuild 未全部成功(${e.message})⇒ 改为逐个包重试`);
    }
    // ② 逐个「声明为平台专属、且本平台需要」的模块 rebuild:幂等,失败只影响它自己,并逐条报出来。
    //    这样后面 analyze() 的「有没有 .node」判断才是可靠的,而不是随整树中断位置漂移。
    const policy = readRepackPlatforms();
    const hostKey = `${process.platform}-${process.arch}`;
    const failedRebuild = [];
    for (const [alias, decl] of policy.perModule) {
      if (decl.platform !== true) continue; // 平台无关的包靠 prebuilds,不需要现编
      const wanted = decl.targets ?? policy.allTargets ?? null;
      if (Array.isArray(wanted) && !wanted.includes(hostKey)) continue; // 本平台不需要它
      const pkgDir = join(dir, 'node_modules', ...alias.split('/'));
      if (!existsSync(join(pkgDir, 'package.json'))) continue;
      try {
        npm(['rebuild', alias], dir);
      } catch (e) {
        failedRebuild.push(alias);
        console.warn(`  ⚠ ${hostKey}: ${alias} rebuild 失败(${e.message})`);
      }
    }
    if (failedRebuild.length > 0) {
      console.warn(`  ⚠ ${relative(pkgRoot, dir)}:${failedRebuild.length} 个原生包 rebuild 失败`
        + `(${failedRebuild.join(', ')})—— 若它们在白名单里却没有 .node,最后的硬闸门会直接判失败`);
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

/** ELF e_machine(0x3e=x86-64 / 0xb7=AArch64),用于 Linux 目标的静态校验。 */
function elfMachine(file) {
  try {
    const b = readFileSync(file);
    if (b[0] !== 0x7f || b[1] !== 0x45 || b[2] !== 0x4c || b[3] !== 0x46) return null;
    return `0x${b.readUInt16LE(0x12).toString(16)}`;
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

/** --reuse:从现有 repack/build + 重打包表还原「重打包集」,不重新分析源树。
 *  @returns {{modules:{alias:string,package:string,version:string,platform:boolean}[],
 *             declare:{name:string,version:string}[], reusedItems:{dir:string,file:string}[]}} */
function reuseExisting(targets) {
  const buildRoot = join(OUT, 'build');
  if (!existsSync(buildRoot)) throw new Error('--reuse 需要 repack/build 已存在(先跑一次完整流程)');
  const modules = readModules(targets);
  if (modules.length === 0) {
    throw new Error('--reuse 需要 lib/vendored.json、repack/aggregator/*/package.json 或一个已安装的 profile 用于还原重打包表');
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
  // 纯 JS 直装集:插件现有 dependencies 里既不是树包、也不是重打包子包的项
  const vendoredNames = new Set(modules.map((m) => m.package));
  const pluginPkg = readJson(join(pkgRoot, 'package.json'));
  const declare = Object.entries(pluginPkg.dependencies ?? {})
    .filter(([name]) => !vendoredNames.has(name) && !/\/(?:dshcs-vscode-server|dshcs-code-server)$/.test(name))
    .map(([name, version]) => ({ name, version }));
  rmSync(join(OUT, 'aggregator'), { recursive: true, force: true });
  console.log(`[repack] --reuse:复用 ${reusedItems.length} 个已打包目录、${modules.length} 个重打包条目、${declare.length} 个纯 JS 直装依赖`);
  return { modules, declare, reusedItems };
}

/** 重打包子包的平台后缀(平台专属包才有),如 `@<scope>/dshcs-kerberos-win32-arm64`。 */
const PLATFORM_SUFFIX = /-(win32|darwin|linux)-(arm64|x64)$/;

/** 由「原名 + 真包名 + 版本」得到重打包条目(平台专属的存**基名**,运行时按目标拼后缀)。 */
function moduleEntry(alias, pkgName, version) {
  const hit = PLATFORM_SUFFIX.exec(pkgName);
  return hit === null
    ? { alias, package: pkgName, version, platform: false }
    : { alias, package: pkgName.slice(0, -hit[0].length), version, platform: true };
}

/** 读「原名 → 重打包子包」表:优先 lib/vendored.json(0.3.45 起),
 *  否则从平台聚合包清单(0.3.44 及更早)或已安装 profile 迁移,再否则返回空表。 */
function readModules(targets) {
  const vendoredFile = join(pkgRoot, 'lib', 'vendored.json');
  const doc = readJson(vendoredFile);
  if (doc !== null && Array.isArray(doc.modules) && doc.modules.length > 0) {
    const modules = doc.modules
      .filter((m) => m !== null && typeof m === 'object' && typeof m.alias === 'string' && typeof m.package === 'string')
      .map((m) => ({
        alias: m.alias,
        package: m.package,
        version: typeof m.version === 'string' ? m.version : null,
        platform: m.platform === true,
      }))
      .sort((a, b) => a.alias.localeCompare(b.alias));
    if (modules.length > 0) {
      console.log(`[repack] 读 lib/vendored.json:${modules.length} 个重打包条目`);
      return modules;
    }
  }
  // 迁移:旧的聚合包清单(每个目标一份,dependencies 里是 npm: 别名)
  let source = null;
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
    if (map.size > 0) { source = { label: `repack/aggregator/${target}`, map }; break; }
  }
  // 与已安装 profile 的别名取并集:聚合包清单可能在上一次失败的重建里丢过条目
  const base = hostMapFromProfile();
  if (source === null && base === null) return [];
  const merged = new Map(source !== null ? source.map : []);
  if (base !== null) {
    let added = 0;
    for (const [orig, info] of base) {
      if (!merged.has(orig)) { merged.set(orig, info); added += 1; }
    }
    if (added > 0) console.log(`[repack] 重打包表缺 ${added} 个条目 → 已用 profile 别名补齐`);
  }
  const modules = [...merged]
    .map(([alias, info]) => moduleEntry(alias, info.pkgName, info.version))
    .sort((a, b) => a.alias.localeCompare(b.alias));
  console.log(`[repack] 迁移 ${modules.length} 个重打包条目(${source !== null ? source.label : 'profile 别名'})→ 将写入 lib/vendored.json`);
  return modules;
}

/** 重打包模块的平台政策(scripts/repack-platforms.json,**人工评审**;本脚本只读不写)。
 *  @returns {{allTargets:string[]|null, publishedTargets:string[]|null,
 *             perModule:Map<string,{platform:boolean|null, targets:string[]|null}>}} */
function readRepackPlatforms() {
  const doc = readJson(join(here, 'repack-platforms.json'));
  const list = (v) => (Array.isArray(v) ? v.filter((t) => typeof t === 'string' && t !== '') : null);
  const allTargets = list(doc?.targets);
  if (allTargets === null || allTargets.length === 0) {
    console.warn('  ⚠ 读不到 scripts/repack-platforms.json 的 targets ⇒ 平台政策退化为「构建目标即全部目标」,'
      + '每模块白名单与跨平台保留都会失效');
  }
  const perModule = new Map();
  for (const [alias, spec] of Object.entries(doc?.modules ?? {})) {
    if (spec === null || typeof spec !== 'object') continue;
    perModule.set(alias, {
      platform: typeof spec.platform === 'boolean' ? spec.platform : null,
      targets: list(spec.targets),
      // 可选:我们自己定义的版本(重打包内容变了、而上游版本没变时用它,例如 2.1.1-dshcs.2)。
      version: typeof spec.version === 'string' && spec.version !== '' ? spec.version : null,
    });
  }
  return { allTargets, publishedTargets: list(doc?.publishedTargets), perModule };
}

/** 平台政策落到分析结果上:
 *   ① 分类(是不是平台专属)以声明为准 —— analyze() 的结论随宿主漂移(Linux 上 windows-registry
 *      没有 .node 会被判成平台无关,一旦写进 dependencies,Windows 运行时反而找不到 -win32-* 子包);
 *   ② 平台专属模块补上目标白名单(缺席 = 全部目标);
 *   ③ **保留本次分析看不到的条目**:用 --target 只构建本机目标时,表里其它平台的模块必须原样留下;
 *   ④ 未在声明里登记的模块给出提醒(新模块).
 *  @param modules - 就地修改的重打包条目(来自 analyze 或 --reuse) */
function applyPlatformPolicy(modules, platforms, allTargets) {
  const declared = (alias) => platforms.perModule.get(alias);
  const existing = readJson(join(pkgRoot, 'lib', 'vendored.json'));
  const previous = new Map((Array.isArray(existing?.modules) ? existing.modules : [])
    .filter((e) => e !== null && typeof e === 'object' && typeof e.alias === 'string')
    .map((e) => [e.alias, e]));

  for (const m of modules) {
    const decl = declared(m.alias);
    if (decl === undefined) {
      console.warn(`  ⚠ ${m.alias} 不在 scripts/repack-platforms.json 的模块表里 ⇒ 沿用分析结论`
        + `(platform=${m.platform});建议登记它,否则换宿主平台时分类会漂移`);
    } else if (decl.platform !== null && decl.platform !== m.platform) {
      console.warn(`  ⚠ ${m.alias}:分析结论 platform=${m.platform},声明写的是 platform=${decl.platform} ⇒ 以声明为准`);
      m.platform = decl.platform;
    }
    // 版本政策(**必须宿主与时点都无关**):① 声明里钉的 `version` 优先;② 否则沿用表里**已发布**的
    // 版本;③ 只有表里没有这个模块(新模块)时才采用源树版本。
    // 为什么不能照源树写:表里的版本就是 registry 上我们发布的那个号,而源树的版本会漂 ——
    //   · kerberos:源树上游 2.1.1,我们发布的是 2.1.1-dshcs.1(聚合包时代的后缀);
    //   · @vscode/proxy-agent:同一个 code-server 版本,维护者当时装到 0.44.0,今天全新装到 0.45.0
    //     —— 依赖范围允许漂移,而 0.45.0 这个子包我们根本没发过。
    // 照源树写 ⇒ 换个宿主平台或换一天重跑,插件依赖就会指向不存在的版本,装上直接解析失败。
    // 要让插件升到新上游版本:在 scripts/repack-platforms.json 里给该模块钉 `version`,重跑本脚本
    // 并把新子包发出去(下面这行会说明清楚)。
    const prevVersion = typeof previous.get(m.alias)?.version === 'string' ? previous.get(m.alias).version : null;
    if (decl?.version !== null && decl?.version !== undefined) {
      if (decl.version !== m.version) console.log(`  · ${m.alias}:按声明钉版本 ${decl.version}(源树里是 ${m.version})`);
      m.version = decl.version;
    } else if (prevVersion !== null) {
      if (prevVersion !== m.version) {
        console.log(`  · ${m.alias}:沿用表里已发布的版本 ${prevVersion}(源树里是 ${m.version});`
          + `要让插件改用它,请在 scripts/repack-platforms.json 里钉 version=${m.version} 并先发布对应的子包`);
      }
      m.version = prevVersion;
    } else {
      console.log(`  · ${m.alias}:新模块 ⇒ 采用源树版本 ${m.version}(记得先发布子包再把它写进依赖表)`);
    }
  }

  const seen = new Set(modules.map((m) => m.alias));
  const kept = [];
  for (const e of [...previous.values()]) {
    if (e === null || typeof e !== 'object' || typeof e.alias !== 'string' || seen.has(e.alias)) continue;
    const decl = declared(e.alias);
    kept.push({
      alias: e.alias,
      package: typeof e.package === 'string' && e.package !== '' ? e.package : `${SCOPE}/dshcs-${flat(e.alias)}`,
      version: typeof e.version === 'string' ? e.version : null,
      platform: decl?.platform ?? e.platform === true,
      targets: decl?.targets ?? (Array.isArray(e.targets) ? e.targets : null),
      carried: true,
    });
    seen.add(e.alias);
  }
  if (kept.length > 0) {
    console.log(`[repack] 保留 ${kept.length} 个本次分析看不到的条目(其它平台的模块):${kept.map((k) => k.alias).join(', ')}`);
    modules.push(...kept);
    modules.sort((a, b) => a.alias.localeCompare(b.alias));
  }

  for (const m of modules) {
    if (!m.platform) continue;
    const wanted = m.targets ?? declared(m.alias)?.targets ?? null;
    m.targets = wanted === null ? [...allTargets] : allTargets.filter((t) => wanted.includes(t));
    if (m.targets.length === 0) {
      console.warn(`  ⚠ ${m.alias}(平台专属)在白名单里没有任何目标 ⇒ 不会产出任何子包`);
    }
  }
  for (const [alias, decl] of platforms.perModule) {
    if (seen.has(alias) || decl.platform !== true) continue;
    console.warn(`  ⚠ 声明里的 ${alias} 既不在本次分析结果、也不在 lib/vendored.json 里 ⇒ 无法为它产出子包`);
  }
  return modules;
}

/** 平台专属重打包包(写在插件 `optionalDependencies`)自带的**注册表依赖** —— 必须同时提成插件
 *  自己的直接依赖。原因(0.3.46 实测,复现与证据见 docs/desktop-first-install-root-cause.md 第 5 节):
 *  pnpm 的增量 hoisted 安装会把「optional 子树里 depth≥2」的依赖整支丢进 `node_modules/.modules.yaml`
 *  的 `skipped`(`bindings` / `fs-extra` / `uuid` / `mkdirp` 全在内),而 dsh-desktop 在 `pnpm add`
 *  之后**立刻**用 `require.resolve.paths()` 校验依赖图 ⇒ 首次安装报
 *  `@jinsiyu/dshcs-kerberos-win32-arm64 requires missing bindings@^1.5.0`;
 *  更糟的是 `pnpm install --frozen-lockfile` 会认为 «Already up to date»(锁文件本身也缺这些条目),
 *  于是 profile 永远修不好,只能靠删 node_modules 重装。提到插件根依赖后它们落在 profile 根
 *  `node_modules`,校验器与运行时都能解析到。这些都是纯 JS、无 ABI 约束,版本在此钉死;
 *  将来平台专属包新增注册表依赖时 verifyOptionalSubtreeDeps() 会在构建期直接报错。 */
const OPTIONAL_SUBTREE_DEPS = {
  bindings: '1.5.0',
  mkdirp: '1.0.4',
  'fs-extra': '11.4.0',
  uuid: '14.0.2',
};

/** 构建期闸门:平台专属重打包清单里的每个非别名依赖都必须落在**插件根依赖**里,
 *  否则 pnpm 会把它丢进 skipped。两条来源都算数:
 *    · OPTIONAL_SUBTREE_DEPS(仅这些包才需要、由本表钉版本的,例如 bindings);
 *    · 树自己的直装集 `declare`(例如 node-addon-api —— VS Code 树本来就把它列为直接依赖,
 *      生成器会按树里的版本写进插件 dependencies,同样落在 profile 根 node_modules)。
 *  @param dirs - 已生成的平台专属重打包目录。
 *  @param directDeps - 本次将写进插件 dependencies 的名字集合。 */
function verifyOptionalSubtreeDeps(dirs, directDeps) {
  const seen = new Set();
  for (const dir of dirs) {
    const m = readJson(join(dir, 'package.json'));
    if (m === null) continue;
    for (const fld of ['dependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(m[fld] ?? {})) {
        if (String(spec).startsWith('npm:')) continue; // 已重打包(真名子包),不走注册表
        seen.add(name);
        if (!Object.hasOwn(OPTIONAL_SUBTREE_DEPS, name) && !directDeps.has(name)) {
          throw new Error(`${m.name}: 注册表依赖 ${name}@${spec} 既不在 OPTIONAL_SUBTREE_DEPS、也不在插件的`
            + ' 直装依赖里 —— 它位于 optional 子树(depth≥2),pnpm 的增量 hoisted 安装会丢包,'
            + ' dsh-desktop 安装后立刻校验必报 requires missing;请把它提为插件直接依赖'
            + '(见 docs/desktop-first-install-root-cause.md 第 5 节)');
        }
      }
    }
  }
  const unused = Object.keys(OPTIONAL_SUBTREE_DEPS).filter((name) => !seen.has(name));
  if (unused.length > 0) {
    console.warn(`  ⚠ OPTIONAL_SUBTREE_DEPS 里的 ${unused.join(', ')} 已不再被任何平台专属包需要,可以删掉`);
  }
}

function main() {
  const hostKey = `${process.platform}-${process.arch}`;
  // 「构建哪些目标」(--target,缺省本机)与「产品覆盖哪些目标」是两件事:前者只影响本次构建,
  // 后者来自 scripts/repack-platforms.json,决定 lib/vendored.json 的 targets、每模块白名单与插件
  // optionalDependencies —— 否则在 Windows 上构建会把 Linux 的条目从依赖表里挤掉(反之亦然)。
  const platforms = readRepackPlatforms();
  const buildTargets = TARGETS.length > 0 ? TARGETS : [hostKey];
  const allTargets = platforms.allTargets ?? buildTargets;
  const publishedTargets = (platforms.publishedTargets ?? buildTargets).filter((t) => allTargets.includes(t));
  for (const t of buildTargets) {
    if (!allTargets.includes(t)) console.warn(`  ⚠ --target ${t} 不在 repack-platforms.json 的 targets 里(仍按请求构建)`);
  }
  if (publishedTargets.length === 0) {
    throw new Error('repack-platforms.json 的 publishedTargets 与 targets 没有交集 ⇒ 生成不出插件依赖表');
  }
  console.log(`[repack] 平台政策:产品目标 ${allTargets.join(', ')};已发布(可写进插件依赖)${publishedTargets.join(', ')}`);

  let repack = null;
  let modules;
  let declare;
  let reusedItems = [];
  let autoSourceTree = null;
  if (REUSE) {
    ({ modules, declare, reusedItems } = reuseExisting(buildTargets));
  } else {
    const autoSource = FROM === null;
    const sourceTree = autoSource ? prepareSourceTree() : FROM;
    if (autoSource) autoSourceTree = sourceTree;
    ({ repack, declare } = analyze(sourceTree));
    modules = [...repack]
      .map(([name, r]) => ({
        alias: name,
        package: `${SCOPE}/dshcs-${flat(name)}`,
        version: r.pkg.version,
        platform: r.platformSpecific,
      }))
      .sort((a, b) => a.alias.localeCompare(b.alias));
    rmSync(OUT, { recursive: true, force: true });
  }
  applyPlatformPolicy(modules, platforms, allTargets);
  console.log(`\n重打包集(${modules.length}):`);
  for (const m of modules) {
    const tag = m.platform ? `[平台专属 ${m.targets.join('|')}]` : '[全平台]';
    console.log(`  ${m.alias}@${m.version} → ${m.package}${m.platform ? '-<平台>' : ''}${m.carried ? ' (保留)' : ''} ${tag}`);
  }
  console.log(`\n直装集(${declare.length}): ${declare.map((d) => d.name).join(', ')}\n`);

  mkdirSync(join(OUT, 'build'), { recursive: true });

  // 每个目标的包名映射:平台专属的按目标拼后缀,平台无关的到处同名
  const byTarget = new Map();
  for (const target of buildTargets) {
    const map = new Map(); // 原包名 -> { pkgName, version, platformSpecific }
    for (const m of modules) {
      map.set(m.alias, {
        pkgName: `${m.package}${m.platform ? `-${target}` : ''}`,
        version: m.version,
        platformSpecific: m.platform,
      });
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
    // 安装脚本已删,prebuild-install(上游原生包在 install 期下载预编译产物的 CLI)永远不会被调用,
    // 属于纯死重量;留着它还会把 tar-fs → tar-stream → bl → buffer 与 readable-stream →
    // string_decoder 拖进 profile —— dsh-desktop 的校验器用 require.resolve.paths() 解析依赖,
    // 该 API 对与 Node 内建同名的包返回 null,于是"依赖装齐也报 requires missing buffer@^5.5.0"
    // (见 docs/analysis-code-server-as-dsh-plugin.md 第 16 节)。
    for (const fld of ['dependencies', 'optionalDependencies']) {
      if (m[fld]) delete m[fld]['prebuild-install'];
    }
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
      } else if (platform === 'linux') {
        // 同上,ELF 版:e_machine 必须是目标架构(0x3e=x86-64 / 0xb7=AArch64)
        const want = arch === 'x64' ? '0x3e' : '0xb7';
        const files = nodeFilesOf(dir);
        const wrong = files
          .map((file) => [file, elfMachine(file)])
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
  //    「要不要按平台分包」一律以**声明**为准(applyPlatformPolicy 已把结论钉到 modules 上),
  //    源树分析只提供源目录与上游版本。照分析结论走的话,本机工具链编不出 .node 时这些模块会被
  //    静默当成平台无关、打成不带目标后缀的包,而依赖表里照旧写着「每目标一份」。
  if (!REUSE) {
    const independentModules = modules.filter((m) => !m.platform);
    if (SKIP_INDEPENDENT) {
      console.log(`[repack] --skip-independent:跳过 ${independentModules.length} 个平台无关包`
        + '(它们由 win32-x64 腿产出并发布,本腿只产自己的平台专属包)');
    } else for (const m of independentModules) {
      const r = repack.get(m.alias);
      if (r === undefined) continue; // 「保留」条目(本宿主看不到它的包)⇒ 没有源目录可打包
      const dir = writeRepack(r.dir, hostMap.get(m.alias), flat(m.alias));
      plan.push({ dir, file: tgzName(hostMap.get(m.alias).pkgName, m.version) });
    }
  }
  // 3) 平台专属包:host 用现成树,其它目标用交叉安装树(--reuse 时用已打包目录)。
  //    · 白名单不含该目标 ⇒ 不构建(Windows-only 模块不产 -linux-*,反之亦然);
  //    · 该目标上没编出 .node / 源树里没这个模块 ⇒ 也跳过,但**是否致命交给下面的硬闸门**。
  const platformDirs = [];
  const builtByTarget = new Map(buildTargets.map((t) => [t, []]));
  const gradedSpecific = new Map(buildTargets.map((t) => [t, []]));
  const skipped = { policy: [], noBinary: [], missing: [] };
  if (!REUSE) for (const target of buildTargets) {
    const map = byTarget.get(target);
    const eligible = modules.filter((m) => m.platform === true
      && (m.targets ?? allTargets).includes(target) && repack.has(m.alias));
    for (const m of modules) {
      if (m.platform === true && repack.has(m.alias) && !(m.targets ?? allTargets).includes(target)) {
        skipped.policy.push(`${m.alias}@${target}`);
      }
    }
    gradedSpecific.set(target, eligible.map((m) => m.alias));
    const specs = eligible.map((m) => ({ name: m.alias, version: repack.get(m.alias).pkg.version }));
    let crossTree = null;
    if (target !== hostKey && specs.length > 0) crossTree = prepareCrossTree(specs, target);
    for (const m of eligible) {
      const r = repack.get(m.alias);
      const info = map.get(m.alias);
      const srcDir = target === hostKey ? r.dir : join(crossTree, 'node_modules', m.alias);
      if (!existsSync(join(srcDir, 'package.json'))) {
        console.warn(`  ⚠ ${target}: 缺少 ${m.alias},跳过(硬闸门会判定是否致命)`);
        skipped.missing.push(`${m.alias}@${target}`);
        continue;
      }
      if (nodeFilesOf(srcDir).length === 0) {
        console.warn(`  ⚠ ${target}: ${m.alias} 没有产出 .node 二进制 ⇒ 跳过(硬闸门会判定是否致命)`);
        skipped.noBinary.push(`${m.alias}@${target}`);
        continue;
      }
      const dir = writeRepack(srcDir, info, `${flat(m.alias)}-${target}`);
      platformDirs.push(dir);
      builtByTarget.get(target).push(m.alias);
      plan.push({ dir, file: tgzName(info.pkgName, m.version) });
    }
    if (crossTree !== null) rmSync(crossTree, { recursive: true, force: true });
  }
  // 3b) --reuse 时平台专属目录已存在(不重新构建),就地复查闸门
  if (REUSE) for (const item of reusedItems) {
    if (PLATFORM_SUFFIX.test(String(readJson(join(item.dir, 'package.json'))?.name ?? ''))) platformDirs.push(item.dir);
  }
  // 产物 → (目标, 模块) 反查:目录名就是「flat(别名)-目标」。记账(`builtByTarget`)与实际产出的
  // 集合必须**逐个模块**一致 —— 只比个数会漏掉「各 2 个但不是同一批」这种错位
  // (2026-09-16 实测:原生包没编出来时,kerberos 被判成平台无关、目录不带后缀,而 tgz 名却按声明带了
  //  -linux-x64 后缀,个数还刚好相等)。
  const packedByTarget = new Map(buildTargets.map((t) => [t, new Set()]));
  for (const dir of platformDirs) {
    const base = basename(dir);
    for (const target of buildTargets) {
      for (const m of modules) {
        if (m.platform === true && base === `${flat(m.alias)}-${target}`) packedByTarget.get(target).add(m.alias);
      }
    }
  }
  // 每个构建目标一行结论(CI 里同时发 annotation:Actions 原始日志要鉴权读不回,
  // annotation 匿名可读,且 ≤20 条上限 —— 所以这里**只发汇总行**,不逐个模块发)。
  if (REUSE) {
    const line = `[repack] --reuse:复用 ${platformDirs.length} 个平台专属目录(不重新构建,故不做白名单/二进制过滤)`;
    console.log(line);
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::notice::${line}`);
  } else for (const target of buildTargets) {
    const built = builtByTarget.get(target) ?? [];
    const graded = gradedSpecific.get(target) ?? [];
    const packed = packedByTarget.get(target) ?? new Set();
    const n = (list) => list.filter((s) => s.endsWith(`@${target}`)).length;
    const line = `[repack] ${target}: 源树判定平台专属 ${graded.length} 个(${graded.join(', ') || '无'})`
      + ` ⇒ 打包 ${packed.size} 个(${[...packed].join(', ') || '无'});白名单排除 ${n(skipped.policy)}`
      + `;无二进制跳过 ${n(skipped.noBinary)}`
      + `${n(skipped.missing) > 0 ? `;目录缺失跳过 ${n(skipped.missing)}` : ''}`
      + `;平台无关 ${modules.filter((m) => !m.platform).length} 个`;
    console.log(line);
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::notice::${line}`);
    const onlyBuilt = built.filter((a) => !packed.has(a));
    const onlyPacked = [...packed].filter((a) => !built.includes(a));
    if (onlyBuilt.length > 0 || onlyPacked.length > 0) {
      const detail = `记账与产物不一致:只记账 ${onlyBuilt.join(', ') || '(无)'};只有产物 ${onlyPacked.join(', ') || '(无)'}`;
      console.warn(`  ⚠ ${target}: ${detail}`);
      if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning::${target}: ${detail}`);
    }
  }
  if (skipped.noBinary.length > 0) {
    console.warn(`  ⚠ 以下「模块×目标」在白名单里但没编出二进制:${skipped.noBinary.join(', ')};`
      + '若该平台确实需要它,查编译日志;若不需要,请从 scripts/repack-platforms.json 里删掉该目标');
  }
  // ── 硬闸门:声明里承诺「某模块在某目标上有子包」,就必须真的产出 ──────────────────────────
  // 为什么必须有它:`npm rebuild` 的失败是被 try/catch 吞掉的(单个原生包编不出来不该卡住整条链),
  // 于是「本机工具链编不出 .node」会静默退化成「这个模块被当成平台无关、打成不带目标后缀的包」,
  // 而依赖表里照旧写着「每目标一份」—— 发出去的就是一套装不起来的东西,而 CI 仍然是绿的。
  // 2026-09-16 维护者问「为什么 CI 输出里有 npm error 仍然通过了」时暴露:Linux 腿上
  // @vscode/spdlog / sqlite3 / kerberos 都 npm error,5 个承诺的包只产出 2 个,run 却是绿的。
  {
    const missing = [];
    for (const target of buildTargets) {
      const produced = packedByTarget.get(target) ?? new Set();
      for (const m of modules) {
        if (m.platform !== true || !(m.targets ?? allTargets).includes(target)) continue;
        if (!produced.has(m.alias)) missing.push(`${m.alias}@${target}`);
      }
    }
    if (missing.length > 0) {
      const detail = `声明(scripts/repack-platforms.json)里承诺却没产出子包的「模块×目标」:${missing.join(', ')}`;
      const hint = '常见原因:① 本机工具链编不出该原生包 —— 日志里的 npm error / MSB8020 就是它'
        + '(Windows 上注意 MSVC 工具集版本;装对应工具集,或改在 CI 腿上构建);'
        + '② 源树里没有这个模块(npm install 失败,或上游把它去掉了);'
        + '③ 该目标本来就不该有这个模块 ⇒ 从该模块的 targets 里删掉这个目标。';
      console.error(`[repack] ✗ ${detail}`);
      if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error::${detail} —— ${hint}`);
      throw new Error(`${detail} —— ${hint}`);
    }
  }
  verifyOptionalSubtreeDeps(platformDirs, new Set([
    ...declare.map((d) => d.name),
    ...Object.keys(OPTIONAL_SUBTREE_DEPS),
  ]));
  // 3) 重打包表(lib/vendored.json,随插件发布):运行时用它把真名子包补成原始名字
  const vendoredDoc = {
    schemaVersion: 1,
    generatedBy: 'scripts/vendor-repacks.mjs',
    scope: SCOPE,
    targets: allTargets,
    modules: modules.map((m) => {
      const entry = { alias: m.alias, package: m.package, version: m.version };
      if (m.platform) {
        entry.platform = true;
        // 每模块目标白名单:运行时(lib/native.js)据此跳过本平台不适用的模块 ——
        // 否则 Linux 上会去找 @jinsiyu/dshcs-vscode-windows-registry-linux-x64,把缺包报成故障。
        entry.targets = [...(Array.isArray(m.targets) ? m.targets : allTargets)];
      }
      return entry;
    }),
  };
  writeFileSync(join(pkgRoot, 'lib', 'vendored.json'), `${JSON.stringify(vendoredDoc, null, 2)}\n`, 'utf8');
  const independent = modules.filter((m) => !m.platform);
  const specific = modules.filter((m) => m.platform);
  console.log(`[repack] 重打包表 → lib/vendored.json(${modules.length} 个:全平台 ${independent.length} / 平台专属 ${specific.length})`);

  writeFileSync(join(OUT, 'pack-plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8');
  console.log(`[repack] 生成 ${plan.length} 个待打包目录 → repack/ (计划:repack/pack-plan.json)`);

  // 4) 改写插件 package.json 的依赖:树 + 纯 JS 直装集 + **全平台**重打包包写 dependencies(真名);
  //    平台专属的重打包包按目标写 optionalDependencies(真名 + 包自带 os/cpu,包管理器按架构自动选),
  //    它们自己的注册表依赖再由 OPTIONAL_SUBTREE_DEPS 提到 dependencies(否则 pnpm 丢包,见该表注释)。
  //    这样每个包在依赖图里都是「根项目的直接依赖」,不依赖 pnpm 对可选子树别名的处理
  //    (见 docs/desktop-first-install-root-cause.md)。
  const pkgFile = join(pkgRoot, 'package.json');
  const pluginPkg = readJson(pkgFile);
  pluginPkg.dependencies = Object.fromEntries([
    [vscodePkg.name, vscodePkg.version],
    ...declare.map((d) => [d.name, d.version]),
    ...independent.map((m) => [m.package, m.version]),
    ...Object.entries(OPTIONAL_SUBTREE_DEPS),
  ].sort(([a], [b]) => a.localeCompare(b)));
  pluginPkg.optionalDependencies = Object.fromEntries(publishedTargets
    .flatMap((t) => specific.filter((m) => m.targets.includes(t)).map((m) => [`${m.package}-${t}`, m.version]))
    .sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(pkgFile, JSON.stringify(pluginPkg, null, 2) + '\n', 'utf8');
  console.log(`[repack] 已写入 package.json:dependencies ${Object.keys(pluginPkg.dependencies).length} 个`
    + `(VS Code 树 + 纯 JS + ${independent.length} 个全平台重打包包`
    + ` + ${Object.keys(OPTIONAL_SUBTREE_DEPS).length} 个 optional 子树兜底依赖),`
    + `optionalDependencies ${Object.keys(pluginPkg.optionalDependencies).length} 个`
    + `(${specific.length} 个平台专属重打包包 × 已发布目标 ${publishedTargets.join('|')},按每模块白名单取交集)`);
  const pendingTargets = allTargets.filter((t) => !publishedTargets.includes(t));
  if (pendingTargets.length > 0) {
    console.log(`[repack] 注意:${pendingTargets.join(', ')} 的子包**还没发布到 npm** ⇒ 暂不写进插件依赖`
      + '(写进去会让 pnpm install 解析一个不存在的包)。发布后把 scripts/repack-platforms.json 的'
      + ' publishedTargets 补齐、再跑一次本脚本,并刷新 pnpm-lock.yaml');
  }

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
