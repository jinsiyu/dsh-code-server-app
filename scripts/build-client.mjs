// scripts/build-client.mjs — 构建 client bundle(单文件,loader 工厂格式)
// esbuild CJS 打包 src/factory.js → lib/client.js:
//   - motion/react 内嵌;
//   - react / react-dom / react/jsx-runtime 外置为静态 require,
//     落在外层 factory(require) 参数上(DSH 冻结模块表);
//   - banner/footer 包出 window.__ModuleLoader__.load({ id, factory }) 形态,
//     factory 内部提供 module/exports,末尾 return module.exports。
import fs from 'node:fs';
import es from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = new URL('.', import.meta.url);
const root = new URL('..', here);

const banner = fs.readFileSync(new URL('client.banner.js', here), 'utf8').trimEnd();
const footer = fs.readFileSync(new URL('client.footer.js', here), 'utf8').trimStart();

const result = es.buildSync({
  entryPoints: [fileURLToPath(new URL('src/factory.js', root))],
  bundle: true,
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  format: 'cjs',
  platform: 'browser',
  target: 'es2018',
  minify: true,
  outfile: fileURLToPath(new URL('lib/client.js', root)),
  banner: { js: banner },
  footer: { js: footer },
  logLevel: 'info',
});

console.log('build:client done -> lib/client.js', result.contents ? '' : '');
