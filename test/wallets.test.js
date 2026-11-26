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
import { startWallets, inTheList } from '../src/wallets.js';

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
  const message = {
    textContent: '',
    hidden: true,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    hasAttribute(name) { return name in this.attributes; },
  };
  // The server-rendered sentences the module picks from, as a template renders them.
  const texts = {
    confirm: 'Confirm in your wallet',
    submitted: 'Sent',
    'error-mismatch': 'Switch to %network%',
    'error-other': 'Failed',
    'network-testnet': 'XRPL Testnet',
  };
  const section = {
    querySelector: (selector) => {
      if (selector === '[data-ld-wallet-app]') return appButton;
      if (selector === '[data-ld-wallet-message]') return message;
      const key = /^\[data-ld-wallet-text="(.+)"\]$/.exec(selector);
      if (key && key[1] in texts) return { textContent: texts[key[1]] };
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
    confirm: (network = 'testnet') => confirm({ address: 'rCustomer', network: { id: network } }),
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

/*
 * What the customer reads after a wallet payment: an error is marked so the
 * stylesheet sets it apart from the hint above it (it read like a continuation
 * of that hint); a confirmation or a submitted payment is not.
 */
async function payOn(network, root = fakeRoot()) {
  const wallet = fakeLibrary();
  const originalWindow = globalThis.window;
  globalThis.window = { location: { reload: () => {} } };
  try {
    startWallets(root, { loadLibrary: async () => wallet.lib });
    const paying = root.appButton.click();
    await settle();
    assert.equal(root.message.textContent, 'Confirm in your wallet');
    assert.equal(root.message.hasAttribute('data-ld-wallet-error'), false, 'asking to confirm is no error');
    wallet.confirm(network);
    await paying;
  } finally {
    globalThis.window = originalWindow;
  }
  return { root, signed: wallet.signed };
}

test('a wallet on another network shows the warning, marked as an error, and signs nothing', async () => {
  const { root, signed } = await payOn('mainnet');
  assert.equal(signed.length, 0);
  assert.equal(root.message.textContent, 'Switch to XRPL Testnet');
  assert.equal(root.message.hidden, false);
  assert.equal(root.message.hasAttribute('data-ld-wallet-error'), true);
});

test('a submitted payment is no error, also right after one', async () => {
  const { root } = await payOn('mainnet');
  assert.equal(root.message.hasAttribute('data-ld-wallet-error'), true);
  await payOn('testnet', root);
  assert.equal(root.message.textContent, 'Sent');
  assert.equal(root.message.hasAttribute('data-ld-wallet-error'), false);
});

/** The section with a WalletConnect button and a page with a project ID, for the tests below. */
function walletConnectRoot(attributes = {}) {
  const root = fakeRoot();
  const connectButton = { addEventListener(type, fn) { this.click = fn; } };
  const section = root.elements['[data-ld-wallet-section]'];
  const sectionQuery = section.querySelector;
  section.querySelector = (selector) => (selector === '[data-ld-wallet-connect]' ? connectButton : sectionQuery(selector));
  root.setAttribute('data-ld-wc-project', '1557f5d5d6b1cae2e12cad3a1e6f762c');
  Object.entries(attributes).forEach(([name, value]) => root.setAttribute(name, value));
  return { root, connectButton };
}

async function clickWalletConnect(root, connectButton, origin = 'https://shop.example', href = origin + '/') {
  const wallet = fakeLibrary();
  const made = [];
  wallet.lib.Adapters.WalletConnect = class { constructor(options) { made.push(options); } };
  const asked = [];
  wallet.lib.WalletManager = class {
    connect(id) { asked.push(id); return Promise.resolve({ address: 'rCustomer', network: { id: 'testnet' } }); }
    async disconnect() {}
    async signAndSubmit() {}
  };
  const originalWindow = globalThis.window;
  const { hostname } = new URL(origin);
  globalThis.window = { location: { origin, hostname, href, reload() {} }, matchMedia: () => ({ matches: false }) };
  try {
    startWallets(root, { loadLibrary: async () => wallet.lib });
    await connectButton.click();
  } finally {
    globalThis.window = originalWindow;
  }
  return { options: made[0], asked };
}

test('the WalletConnect button connects WalletConnect, with its own dialog, as the shop', async () => {
  const { root, connectButton } = walletConnectRoot({ 'data-ld-shop-name': 'Demo Shop', 'data-ld-shop-icon': '/media/logo.png' });
  const { options, asked } = await clickWalletConnect(root, connectButton);
  assert.deepEqual(asked, ['walletconnect']);
  assert.equal(options.projectId, '1557f5d5d6b1cae2e12cad3a1e6f762c');
  assert.equal(options.useModal, true);
  assert.equal(options.modalMode, 'always');
  assert.deepEqual(options.metadata, {
    name: 'Demo Shop', description: 'Demo Shop', url: 'https://shop.example', icons: ['https://shop.example/media/logo.png'],
  });
});

test('without a rendered shop name and icon, the wallet sees the host and its favicon', async () => {
  const { root, connectButton } = walletConnectRoot();
  const { options } = await clickWalletConnect(root, connectButton);
  assert.deepEqual(options.metadata, {
    name: 'shop.example', description: 'shop.example', url: 'https://shop.example', icons: ['https://shop.example/favicon.ico'],
  });
});

test('without a project ID the WalletConnect button does nothing', () => {
  const { root, connectButton } = walletConnectRoot();
  root.setAttribute('data-ld-wc-project', '');
  startWallets(root, { loadLibrary: async () => { throw new Error('must not load'); } });
  assert.equal(connectButton.click, undefined);
});

test('a relative icon URL is the page\'s, as an <img> on it would read it', async () => {
  const { root, connectButton } = walletConnectRoot({ 'data-ld-shop-icon': 'images/logo.png' });
  const { options } = await clickWalletConnect(root, connectButton, 'https://shop.example', 'https://shop.example/checkout/pay');
  assert.deepEqual(options.metadata.icons, ['https://shop.example/checkout/images/logo.png']);
});

test('WalletConnect leaves the browser-wallet list only where it has its own button', () => {
  const available = [{ id: 'joey' }, { id: 'walletconnect' }, { id: 'xaman' }];
  // With [data-ld-wallet-connect]: the button is the way in, the list holds browser wallets.
  assert.deepEqual(inTheList(available, true).map((a) => a.id), ['joey', 'xaman']);
  // A template from before the button: the list stays its only way in on a desktop.
  assert.deepEqual(inTheList(available, false).map((a) => a.id), ['joey', 'walletconnect', 'xaman']);
  // Without WalletConnect configured there is nothing to take out.
  assert.deepEqual(inTheList([{ id: 'joey' }], true).map((a) => a.id), ['joey']);
});
