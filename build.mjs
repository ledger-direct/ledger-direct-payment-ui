import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });

// The page: a classic script. The wallet library is external, so the bundler
// fallback `import('xrpl-connect')` in wallets.js stays a bare native import()
// that the classic entry never executes — it always passes its own loader,
// a native import() of the URL in data-ld-wallets-src.
await build({
  entryPoints: ['entry/classic.js'],
  outfile: 'dist/payment-page.js',
  bundle: true,
  format: 'iife',
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
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
});

await copyFile('src/payment-page.css', 'dist/payment-page.css');
console.log('dist/payment-page.js, dist/wallets.js, dist/payment-page.css');
