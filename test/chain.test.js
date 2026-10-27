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

/*
 * The page-level gate. showState() re-applies the wallet section's
 * visibility on every state change, so hiding it in the wallet module alone
 * would last until the first poll. A fake root is enough: the page touches
 * only what it finds, and here it finds the wallet section and nothing else.
 */
import { startPaymentPage } from '../src/payment-page.js';

function fakePage(attributes) {
  const section = { hidden: false, querySelector: () => null };
  const root = {
    section,
    getAttribute: (name) => attributes[name] ?? null,
    setAttribute() {},
    querySelector: (selector) => (selector === '[data-ld-wallet-section]' ? section : null),
    querySelectorAll: (selector) => (selector === '[data-ld-wallet-section]' ? [section] : []),
    addEventListener() {},
    dispatchEvent() {},
  };
  return root;
}

async function startAndReceive(attributes, payload) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => payload });
  try {
    const root = fakePage(attributes);
    const page = startPaymentPage(root);
    await page.checkNow();
    return { root, page };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const partial = { schema_version: 1, state: 'partial', base_asset: 'XLM', amount_requested: 2.2, amount_paid: 1.5, shortfall: 0.7, seconds_left: null };

test('a Stellar page keeps the wallet section hidden through a state change', async () => {
  const { root, page } = await startAndReceive({ 'data-ld-chain': 'STELLAR', 'data-ld-state': 'waiting' }, partial);
  assert.equal(page.state, 'partial', 'the status update was applied');
  assert.equal(root.section.hidden, true);
});

test('an XRPL page shows the wallet section in every state but expired', async () => {
  for (const attributes of [{ 'data-ld-chain': 'XRPL', 'data-ld-state': 'waiting' }, { 'data-ld-state': 'waiting' }]) {
    const { root, page } = await startAndReceive(attributes, partial);
    assert.equal(page.state, 'partial');
    assert.equal(root.section.hidden, false);

    const expired = await startAndReceive(attributes, { ...partial, state: 'expired' });
    assert.equal(expired.root.section.hidden, true, 'expired hides it, as before');
  }
});
