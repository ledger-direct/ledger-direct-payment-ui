/**
 * The markup contract in src/README.md is what a platform builds its template
 * against. Every attribute the scripts read has to be documented there, and
 * the two the end-to-end harness depends on have to be there by name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const SRC = new URL('../src/', import.meta.url);

async function attributesReadBy(name) {
  const source = await readFile(new URL(name, SRC), 'utf8');
  const found = new Set();
  for (const m of source.matchAll(/data-ld-[a-z-]+/g)) found.add(m[0]);
  // data-ld-block="<state>" and data-ld-wallet-text="<key>" are documented as families.
  return [...found].filter((attribute) => !/^data-ld-(block|status-for|label|fiat-for|copy-label|check-label|wallet-text|wallet-status)$/.test(attribute));
}

test('every data-ld attribute the scripts read is documented in the contract', async () => {
  const readme = await readFile(new URL('README.md', SRC), 'utf8');
  const names = (await readdir(SRC)).filter((name) => name.endsWith('.js'));
  for (const name of names) {
    for (const attribute of await attributesReadBy(name)) {
      assert.ok(readme.includes(attribute), `${name} reads ${attribute}, which src/README.md does not document`);
    }
  }
});

test('the contract names the anchors the end-to-end harness reads', async () => {
  const readme = await readFile(new URL('README.md', SRC), 'utf8');
  for (const anchor of ['data-ld-state', 'data-ld-amount-requested', 'data-ld-asset', 'data-ld-account', 'data-ld-tag', 'data-ld-wallets-src', 'data-ld-poll-url']) {
    assert.ok(readme.includes(anchor), `src/README.md does not mention ${anchor}`);
  }
});

test('the contract states that only settled or a redirect stops the polling', async () => {
  const readme = await readFile(new URL('README.md', SRC), 'utf8');
  assert.match(readme, /Only a `redirect` or `settled` stops the polling/);
});
