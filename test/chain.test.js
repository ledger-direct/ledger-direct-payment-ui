/**
 * data-ld-chain decides which chain-specific modules apply. The wallet module
 * is XRPL's: on a Stellar page it hides the section and wires nothing; on an
 * XRPL page, or one without the attribute, it starts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWallets } from '../src/wallets.js';

function fakeRoot(attributes) {
  const section = {
    hidden: false,
    queried: 0,
    querySelector() { this.queried++; return null; },
  };
  return {
    section,
    getAttribute: (name) => attributes[name] ?? null,
    querySelector: (selector) => (selector === '[data-ld-wallet-section]' ? section : null),
    addEventListener() {},
  };
}

test('on a Stellar page the wallet module hides the section and wires nothing', () => {
  const root = fakeRoot({ 'data-ld-chain': 'STELLAR', 'data-ld-network': 'testnet' });
  startWallets(root);
  assert.equal(root.section.hidden, true);
  assert.equal(root.section.queried, 0, 'no toggle, list or button was looked up');
});

test('on an XRPL page, or without the attribute, the wallet module starts', () => {
  for (const attributes of [{ 'data-ld-chain': 'XRPL' }, {}]) {
    const root = fakeRoot(attributes);
    startWallets(root);
    assert.equal(root.section.hidden, false);
    assert.ok(root.section.queried > 0, 'the module looked its controls up');
  }
});
