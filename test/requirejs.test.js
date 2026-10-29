/**
 * Every Magento page has RequireJS: a global `define` with `define.amd`. The
 * UMD wrappers of bundled dependencies test for it and, finding it, register
 * with RequireJS instead of exporting to CommonJS — the bundle then holds an
 * empty module. Both classic bundles are built with `define` replaced, so no
 * wrapper can take the AMD branch, and neither bundle declares anything in
 * the page's global scope that could break RequireJS itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

for (const file of ['dist/wallets.js', 'dist/payment-page.js']) {
  test(`${file} has no UMD wrapper that could register with RequireJS`, async () => {
    const source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /typeof define\s*[=!]==?\s*["']function["']/, 'a UMD wrapper still tests for define');
    assert.doesNotMatch(source, /define\.amd/, 'a UMD wrapper still reads define.amd');
  });
}

test('the classic bundle leaves the global scope alone', async () => {
  const source = await readFile(new URL('../dist/payment-page.js', import.meta.url), 'utf8');
  assert.ok(!/^var (require|define)\b/m.test(source.slice(0, 200)), 'no global require or define declaration at the top');
});
