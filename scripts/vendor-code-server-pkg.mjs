// scripts/vendor-code-server-pkg.mjs — 把内置 code-server 树打成**平台专属子包**。
//
// 产物(每个目标一个,os/cpu 限定):
//   repack/build/code-server-<target>/
//     package.json                  @jinsiyu/dshcs-code-server-<target>@<code-server 版本>
//     code-server/**                完整 code-server 树(out/ + lib/vscode + 自带的 136 个依赖)
//
// 为什么要放在子目录 code-server/ 而不是包根:npm/pnpm 打包**永远排除包根目录的 node_modules**,
// 放在被 files 覆盖的子目录里才会随包发布(主包 0.1.36 用的就是同一招)。
//
// 为什么子包不写 dependencies:那 136 个依赖已经作为文件打包在 code-server/node_modules 里,
// 写成 dependencies 会让 pnpm 再去 registry 装一份。留着 `dependencies` 字段的是嵌套的
// code-server/package.json(它只是普通文件,不被解析)。
//
// 平台差异只有 argon2 的原生二进制(win32-arm64 上游无预编译 → 打包期编译;
// win32-x64 用 `node-gyp rebuild --arch=x64` 现编,并校验 PE machine)。
//
// 用法:
//   node scripts/vendor-code-server-pkg.mjs [--target win32-arm64,win32-x64] [--pack]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repackDir = join(pkgRoot, 'repack');
const buildDir = join(repackDir, 'build');
const tgzDir = join(repackDir, 'tgz');
const vendorTree = join(pkgRoot, 'vendor', 'code-server');
const npmCache = join(pkgRoot, '.npm-cache');

const argv = process.argv.slice(2);
const DO_PACK = argv.includes('--pack');
const TARGETS = (() => {
  const i = argv.indexOf('--target');
  if (i < 0 || argv[i + 1] === undefined) return [`${process.platform}-${process.arch}`];
  return argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
})();

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

function npm(args, cwd) {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const env = { ...process.env, npm_config_cache: npmCache, npm_config_update_notifier: 'false' };
  const hasCli = existsSync(cli);
  const cmd = hasCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const full = hasCli ? [cli, ...args] : args;
  const res = spawnSync(cmd, full, { cwd, shell: !hasCli && process.platform === 'win32', env, stdio: 'inherit' });
  if ((res.status ?? 1) !== 0) throw new Error(`npm ${args.join(' ')} failed (${res.status})`);
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

/** 为某个目标编译 argon2 原生模块(就地覆盖包内 build/Release/argon2.node)。 */
function buildArgon2(tree, arch) {
  const argon2 = join(tree, 'node_modules', 'argon2');
  if (!existsSync(join(argon2, 'binding.gyp'))) throw new Error(`argon2 不在位: ${argon2}`);
  console.log(`[cs-pkg] 编译 argon2 (--arch=${arch}) …`);
  const ng = join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
  const cli = existsSync(ng) ? ng : null;
  if (cli === null) throw new Error('找不到 node-gyp(需全局安装 node-gyp)');
  const res = spawnSync(process.execPath, [cli, 'rebuild', `--arch=${arch}`], { cwd: argon2, stdio: 'inherit' });
  if ((res.status ?? 1) !== 0) throw new Error(`argon2 编译失败 (${res.status})`);
  const bin = join(argon2, 'build', 'Release', 'argon2.node');
  if (!existsSync(bin)) throw new Error(`argon2 编译产物缺失: ${bin}`);
  return bin;
}

function main() {
  if (!existsSync(join(vendorTree, 'out', 'node', 'entry.js'))) {
    throw new Error('缺少 vendor/code-server;先运行 `node scripts/vendor-code-server.mjs`');
  }
  const csVersion = readJson(join(vendorTree, 'package.json'))?.version;
  if (typeof csVersion !== 'string') throw new Error('读不到 code-server 版本');
  const pluginPkg = readJson(join(pkgRoot, 'package.json'));
  const scope = '@jinsiyu';
  const hostKey = `${process.platform}-${process.arch}`;
  const plan = [];

  for (const target of TARGETS) {
    const [platform, arch] = target.split('-');
    if (platform === undefined || arch === undefined) throw new Error(`--target 需要 <platform>-<arch>,收到 ${target}`);
    const outName = `code-server-${target}`;
    const dir = join(buildDir, outName);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    console.log(`[cs-pkg] 复制 vendor/code-server → ${relative(pkgRoot, join(dir, 'code-server'))}`);
    cpSync(vendorTree, join(dir, 'code-server'), { recursive: true, dereference: false, maxRetries: 6, retryDelay: 250 });

    const tree = join(dir, 'code-server');
    // 目标架构的 argon2 原生二进制
    const wantMachine = arch === 'x64' ? '0x8664' : arch === 'arm64' ? '0xaa64' : null;
    const have = join(tree, 'node_modules', 'argon2', 'build', 'Release', 'argon2.node');
    if (target !== hostKey) {
      const bin = buildArgon2(tree, arch);
      const m = peMachine(bin);
      if (wantMachine !== null && m !== wantMachine) throw new Error(`argon2 PE machine=${m},期望 ${wantMachine}`);
      console.log(`[cs-pkg] argon2 → ${relative(pkgRoot, bin)} (${m})`);
    } else {
      console.log(`[cs-pkg] argon2 沿用本机产物 (${peMachine(have) ?? '?'})`);
    }

    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `${scope}/dshcs-code-server-${target}`,
      version: csVersion,
      description: `Bundled code-server ${csVersion} tree for ${target} (out/ + lib/vscode + its ${readdirSync(join(tree, 'node_modules')).length} runtime deps), repacked so pnpm installs it without any build script.`,
      os: [platform],
      cpu: [arch],
      files: ['code-server'],
      license: 'MIT',
      repository: pluginPkg?.repository ?? undefined,
    }, null, 2) + '\n', 'utf8');
    plan.push({ dir, file: `${`${scope}/dshcs-code-server-${target}`.replace(/^@/, '').replaceAll('/', '-')}-${csVersion}.tgz` });
  }

  if (DO_PACK) {
    mkdirSync(tgzDir, { recursive: true });
    for (const item of plan) {
      console.log(`[cs-pkg] npm pack ${item.file}`);
      npm(['pack', '--pack-destination', tgzDir], item.dir);
    }
  }
  console.log(`[cs-pkg] 完成:${plan.length} 个平台子包 → repack/build/${DO_PACK ? ' + repack/tgz/' : ''}`);
  console.log('[cs-pkg] 下一步:`node scripts/publish-repacks.mjs --only dshcs-code-server` 发布(或用 --dry-run 预览)');
}

main();
