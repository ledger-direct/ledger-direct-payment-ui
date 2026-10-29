import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });

// Every Magento page has RequireJS, so `define` is a global function with `define.amd`. The
// UMD wrappers of bundled dependencies (cross-fetch inside the Xaman SDK, qrcode-generator)
// test exactly that and, finding it, register with RequireJS instead of exporting to
// CommonJS — the bundle then sees an empty module and the wallet library dies with
// "default is not a function". Replacing the identifier at build time keeps every UMD wrapper
// on its CommonJS branch, on any page. Done by esbuild's define, not by a banner: a banner on
// the classic (IIFE) build would land in the page's global scope and break RequireJS itself.
const noAmd = { define: 'undefined' };

// The page: a classic script. The wallet library is external, so the bundler
// fallback `import('xrpl-connect')` in wallets.js stays a bare native import()
// that the classic entry never executes — it always passes its own loader,
// a native import() of the URL in data-ld-wallets-src.
await build({
  entryPoints: ['entry/classic.js'],
  outfile: 'dist/payment-page.js',
  bundle: true,
  format: 'iife',
  define: noAmd,
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  external: ['xrpl-connect'],
});

// The wallets: one ES module with xrpl-connect and its xrpl peer inside.
await build({
  entryPoints: ['entry/wallets.js'],
  outfile: 'dist/wallets.js',
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  // xrpl pulls in Node built-ins through its dependencies; the browser build needs none of them.
  platform: 'browser',
  define: { ...noAmd, 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
});

await copyFile('src/payment-page.css', 'dist/payment-page.css');
console.log('dist/payment-page.js, dist/wallets.js, dist/payment-page.css');
