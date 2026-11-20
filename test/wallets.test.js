/**
 * pay() between the click and the signature. Loading the library and
 * confirming the connection in the wallet can take minutes; whatever the page
 * learned meanwhile decides whether the transaction is still the one to sign.
 *
 * The library is a stand-in passed as options.loadLibrary, the root a fake
 * that holds what the module reads: the attributes, the server-rendered
 * amount, account and tag, and the "pay in app" button that starts pay().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWallets } from '../src/wallets.js';

function fakeRoot({ token = false } = {}) {
  const attributes = {
    'data-ld-state': 'waiting',
    'data-ld-network': 'testnet',
    'data-ld-amount-drops': '747910',
    ...(token ? { 'data-ld-currency': '524C555344000000000000000000000000000000', 'data-ld-issuer': 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV' } : {}),
  };
  const listeners = {};
  const appButton = {
    getAttribute: () => 'xaman',
    addEventListener(type, fn) { this.click = fn; },
  };
  const message = { textContent: '', hidden: true };
  const section = {
    querySelector: (selector) => {
      if (selector === '[data-ld-wallet-app]') return appButton;
      if (selector === '[data-ld-wallet-message]') return message;
      return null;
    },
    querySelectorAll: () => [],
  };
  const elements = {
    '[data-ld-wallet-section]': section,
    '[data-ld-account]': { getAttribute: () => 'raXkRCAYkqaoFYCeVej93SzCTtiAbbRzAg' },
    '[data-ld-tag]': { getAttribute: () => '114729' },
    '[data-ld-amount]': { textContent: token ? '1.17' : '0.74791' },
  };
  return {
    appButton,
    message,
    elements,
    getAttribute: (name) => attributes[name] ?? null,
    setAttribute: (name, value) => { attributes[name] = value; },
    querySelector: (selector) => elements[selector] ?? null,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    dispatchEvent: (event) => { if (listeners[event.type]) listeners[event.type](event); },
  };
}

/** A wallet whose connection the test confirms when it is ready. */
function fakeLibrary() {
  let confirm;
  const connected = new Promise((resolve) => { confirm = resolve; });
  const signed = [];
  class Adapter {}
  const lib = {
    Adapters: { Crossmark: Adapter, GemWallet: Adapter, MetaMaskSnap: Adapter, Ledger: Adapter, Otsu: Adapter, Xyra: Adapter, Xaman: Adapter, WalletConnect: Adapter },
    WalletManager: class {
      connect() { return connected; }
      async disconnect() {}
      async signAndSubmit(transaction) { signed.push(transaction); }
    },
  };
  return {
    lib,
    signed,
    confirm: () => confirm({ address: 'rCustomer', network: { id: 'testnet' } }),
  };
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function payWhile(root, during) {
  const wallet = fakeLibrary();
  let reloads = 0;
  const originalWindow = globalThis.window;
  globalThis.window = { location: { reload: () => { reloads++; } } };
  try {
    startWallets(root, { loadLibrary: async () => wallet.lib });
    const paying = root.appButton.click();
    await settle(); // the library is loaded, the wallet asks the customer
    during();
    wallet.confirm();
    await paying;
  } finally {
    globalThis.window = originalWindow;
  }
  return { signed: wallet.signed, reloads };
}

test('a partial payment while connecting reloads instead of signing the old drops', async () => {
  const root = fakeRoot();
  const { signed, reloads } = await payWhile(root, () => {
    root.dispatchEvent(new CustomEvent('ld:amount', { detail: { amount: '0.44791' } }));
  });
  assert.equal(signed.length, 0);
  assert.equal(reloads, 1);
});

test('a page that turned settled or expired while connecting signs nothing', async () => {
  for (const state of ['settled', 'expired']) {
    const root = fakeRoot();
    const { signed, reloads } = await payWhile(root, () => root.setAttribute('data-ld-state', state));
    assert.equal(signed.length, 0, state);
    assert.equal(reloads, 0, state);
  }
});

test('nothing changed while connecting: the drops from page load are signed', async () => {
  const root = fakeRoot();
  const { signed, reloads } = await payWhile(root, () => {});
  assert.equal(reloads, 0);
  assert.deepEqual(signed, [{
    TransactionType: 'Payment',
    Account: 'rCustomer',
    Destination: 'raXkRCAYkqaoFYCeVej93SzCTtiAbbRzAg',
    DestinationTag: 114729,
    Amount: '747910',
  }]);
});

/*
 * A token amount is read from the displayed amount when the transaction is
 * built, which setAmountDue() keeps current — no drops, so no reload.
 */
test('a token payment signs the new shortfall without a reload', async () => {
  const root = fakeRoot({ token: true });
  const { signed, reloads } = await payWhile(root, () => {
    root.elements['[data-ld-amount]'].textContent = '0.5';
    root.dispatchEvent(new CustomEvent('ld:amount', { detail: { amount: '0.5' } }));
  });
  assert.equal(reloads, 0);
  assert.equal(signed.length, 1);
  assert.equal(signed[0].Amount.value, '0.5');
});

test('a token page pays the shortfall from a partial payment noticed before the click', async () => {
  const root = fakeRoot({ token: true });
  root.elements['[data-ld-amount]'].textContent = '0.5';
  const wallet = fakeLibrary();
  let reloads = 0;
  const originalWindow = globalThis.window;
  globalThis.window = { location: { reload: () => { reloads++; } } };
  try {
    startWallets(root, { loadLibrary: async () => wallet.lib });
    root.dispatchEvent(new CustomEvent('ld:amount', { detail: { amount: '0.5' } }));
    const paying = root.appButton.click();
    await settle();
    wallet.confirm();
    await paying;
  } finally {
    globalThis.window = originalWindow;
  }
  assert.equal(reloads, 0);
  assert.equal(wallet.signed[0].Amount.value, '0.5');
});
