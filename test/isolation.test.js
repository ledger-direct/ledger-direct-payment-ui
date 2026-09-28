/**
 * The boundary: src/ is the payment page for every LedgerDirect plugin and
 * may lean on nothing a shop system provides — only fetch() and the DOM, plus
 * the two libraries it is built around.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url);

const FORBIDDEN = ['PluginManager', 'PluginBaseClass', 'DomAccess', 'HttpClient', 'jQuery', 'window.$', 'Shopware'];
const ALLOWED_PACKAGES = ['qrcode-generator', 'xrpl-connect'];

async function scripts() {
  const names = (await readdir(SRC)).filter((name) => name.endsWith('.js'));
  return Promise.all(names.map(async (name) => ({ name, source: await readFile(new URL(name, SRC), 'utf8') })));
}

test('src/ mentions nothing from a shop system or a framework', async () => {
  for (const { name, source } of await scripts()) {
    for (const needle of FORBIDDEN) {
      assert.ok(!source.includes(needle), `${name} must not mention '${needle}'`);
    }
  }
});

test('src/ imports only relative modules or an allowed library', async () => {
  const importSpecifiers = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const { name, source } of await scripts()) {
    for (const match of source.matchAll(importSpecifiers)) {
      const specifier = match[1] ?? match[2];
      const ok = specifier.startsWith('./') || specifier.startsWith('../') || ALLOWED_PACKAGES.includes(specifier);
      assert.ok(ok, `${name} imports '${specifier}', which is neither relative nor an allowed library`);
    }
  }
});

test('the amounts are never rounded or reformatted in the browser', async () => {
  for (const { name, source } of await scripts()) {
    assert.ok(!/\btoFixed\(/.test(source), `${name} must not call toFixed()`);
    assert.ok(!/\btoLocaleString\(/.test(source), `${name} must not call toLocaleString()`);
  }
});

test('the entry points exist and the classic one loads wallets from data-ld-wallets-src', async () => {
  const classic = await readFile(join('entry', 'classic.js'), 'utf8');
  assert.ok(classic.includes("data-ld-wallets-src"), 'classic.js reads data-ld-wallets-src');
  assert.ok(/import\(walletsSrc\)/.test(classic), 'classic.js imports the wallet library by URL');
  const wallets = await readFile(join('entry', 'wallets.js'), 'utf8');
  assert.ok(wallets.includes("from 'xrpl-connect'"), 'wallets.js re-exports xrpl-connect');
});
