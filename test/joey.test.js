/**
 * The Joey adapter against XRPL Connect itself (its errors, its networks, its
 * WalletManager) and a stand-in for the extension's injected provider. The
 * stand-in answers the way the extension did on the testnet on 2026-11-25:
 * connect → { accounts: [{ address }], chain }, getNetwork → { chain, networkId, name },
 * signAndSubmitTransaction → { tx_json, tx_blob, hash, engine_result, engine_result_message }.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lib from 'xrpl-connect';
import { createJoeyAdapter, findJoey } from '../src/joey.js';

const CUSTOMER = 'rUBWKje8jSTvCZv9kQ2vqS8a8SYGPbcACR';
const SHOP = 'rnRuA7RNi6CsFbkh5FDDiTSSvJwHG8J7if';
const HASH = '690498B596BA937A496888A55A7F4D3606AA416BFD9961B53646ED3C920F10AA';

function refusal(code) {
  return Object.assign(new Error('declined'), { code });
}

/**
 * The extension, on `chain`; `refuse…` makes connect or sign fail with that error.
 * As Joey documents it: getNetwork and signing need a site with access (4100
 * otherwise), connect grants it; `on` answers an unsubscribe function (with
 * `legacyOn`, nothing, and removeListener unsubscribes, as the build we tried has it).
 */
function fakeJoey(options = {}) {
  const { chain = 'xrpl:1', refuseConnect, refuseSign, legacyOn = false } = options;
  const calls = { connect: [], sign: [] };
  const listeners = new Map();
  const joey = {
    isJoey: true,
    chain,
    granted: false,
    async connect(params) {
      calls.connect.push(params);
      if (refuseConnect) throw refuseConnect;
      joey.granted = true;
      return { accounts: [{ address: CUSTOMER }], chain: joey.chain };
    },
    async getNetwork() {
      if (!joey.granted) throw refusal(4100);
      return { chain: joey.chain, networkId: Number(joey.chain.split(':')[1]), name: 'whatever' };
    },
    async signAndSubmitTransaction(params) {
      if (!joey.granted) throw refusal(4100);
      calls.sign.push(params);
      if (refuseSign) throw refuseSign;
      return 'answer' in options ? options.answer : { tx_json: params.tx_json, tx_blob: '1200', hash: HASH, engine_result: 'tesSUCCESS', engine_result_message: 'ok' };
    },
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(callback);
      return legacyOn ? undefined : () => listeners.get(event).delete(callback);
    },
    removeListener(event, callback) {
      listeners.get(event)?.delete(callback);
    },
    /** Joey tells the site something. */
    emit(event, payload) {
      for (const callback of [...(listeners.get(event) ?? [])]) callback(payload);
    },
    listening() {
      return [...listeners.values()].reduce((n, set) => n + set.size, 0);
    },
  };
  return { joey, calls };
}

function adapterFor(joey) {
  return createJoeyAdapter(lib, { provider: () => joey });
}

const payment = { TransactionType: 'Payment', Destination: SHOP, DestinationTag: 3944864302, Amount: '2367460' };

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return true;
  });
}

test('finds the provider at window.xrpl.joey or window.joey, and nothing that cannot pay', () => {
  const { joey } = fakeJoey();
  assert.equal(findJoey({ xrpl: { joey } }), joey);
  assert.equal(findJoey({ joey }), joey);
  assert.equal(findJoey({ xrpl: { crossmark: {} } }), null);
  assert.equal(findJoey({ joey: { connect() {} } }), null);
  assert.equal(findJoey(undefined), null);
});

test('is available only while the extension is there', async () => {
  assert.equal(await createJoeyAdapter(lib, { provider: () => null }).isAvailable(), false);
  assert.equal(await adapterFor(fakeJoey().joey).isAvailable(), true);
});

test('connects on the page\'s network, asking Joey for its CAIP-2 chain', async () => {
  const { joey, calls } = fakeJoey();
  const account = await adapterFor(joey).connect({ network: 'testnet' });
  assert.deepEqual(calls.connect, [{ chain: 'xrpl:1' }]);
  assert.equal(account.address, CUSTOMER);
  assert.equal(account.network.id, 'testnet');
});

test('refuses a wallet on another network than the page', async () => {
  await rejects(adapterFor(fakeJoey({ chain: 'xrpl:0' }).joey).connect({ network: 'testnet' }), 'NETWORK_MISMATCH');
});

test('refuses when Joey answers for the page\'s chain but reports another one', async () => {
  const { joey } = fakeJoey();
  joey.getNetwork = async () => ({ chain: 'xrpl:0', networkId: 0, name: 'Mainnet' });
  await rejects(adapterFor(joey).connect({ network: 'testnet' }), 'NETWORK_MISMATCH');
});

test('takes the wallet\'s network when none is asked for, and only a standard one', async () => {
  const account = await adapterFor(fakeJoey({ chain: 'xrpl:2' }).joey).connect();
  assert.equal(account.network.id, 'devnet');
  await rejects(adapterFor(fakeJoey({ chain: 'xrpl:21337' }).joey).connect(), 'NETWORK_NOT_SUPPORTED');
});

test('does not offer a network Joey does not know', async () => {
  const { joey, calls } = fakeJoey();
  await rejects(adapterFor(joey).connect({ network: 'xahau-testnet' }), 'NETWORK_NOT_SUPPORTED');
  assert.equal(calls.connect.length, 0);
});

test('maps Joey\'s refusals to XRPL Connect\'s', async () => {
  const declined = adapterFor(fakeJoey({ refuseConnect: refusal(4001) }).joey).connect({ network: 'testnet' });
  await assert.rejects(declined, (error) => error.code === 'CONNECTION_REJECTED' && error.category === 'USER_ACTION');
  await rejects(adapterFor(fakeJoey({ refuseConnect: refusal(4901) }).joey).connect({ network: 'testnet' }), 'NETWORK_MISMATCH');
  await rejects(adapterFor(fakeJoey({ refuseConnect: new Error('boom') }).joey).connect({ network: 'testnet' }), 'CONNECTION_FAILED');
  await rejects(createJoeyAdapter(lib, { provider: () => null }).connect({ network: 'testnet' }), 'WALLET_NOT_INSTALLED');
});

test('a connection disconnected while Joey asks its owner is not taken', async () => {
  const { joey } = fakeJoey();
  const adapter = adapterFor(joey);
  let release;
  const connect = joey.connect;
  joey.connect = (params) => new Promise((resolve) => { release = () => resolve(connect(params)); });
  const pending = adapter.connect({ network: 'testnet' });
  await new Promise((resolve) => setImmediate(resolve));
  await adapter.disconnect();
  release();
  await rejects(pending, 'NOT_CONNECTED');
  assert.equal(await adapter.getAccount(), null);
});

test('pays: the page\'s transaction from the connected account, on its chain, autofilled by Joey', async () => {
  const { joey, calls } = fakeJoey();
  const adapter = adapterFor(joey);
  await adapter.connect({ network: 'testnet' });
  const submitted = await adapter.signAndSubmit(payment);
  assert.equal(submitted.hash, HASH);
  assert.deepEqual(calls.sign, [{ tx_json: { ...payment, Account: CUSTOMER }, account: CUSTOMER, chain: 'xrpl:1', autofill: true }]);
});

test('passes a token amount through unchanged', async () => {
  const { joey, calls } = fakeJoey();
  const adapter = adapterFor(joey);
  await adapter.connect({ network: 'testnet' });
  const amount = { currency: '524C555344000000000000000000000000000000', issuer: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV', value: '2.2' };
  await adapter.signAndSubmit({ ...payment, Amount: amount });
  assert.deepEqual(calls.sign[0].tx_json.Amount, amount);
});

test('signs nothing when the owner switched networks after connecting', async () => {
  const { joey, calls } = fakeJoey();
  const adapter = adapterFor(joey);
  await adapter.connect({ network: 'testnet' });
  joey.chain = 'xrpl:0';
  // Named as XRPL Connect names networks, not as a CAIP-2 chain.
  await assert.rejects(adapter.signAndSubmit(payment), (error) => error.code === 'NETWORK_MISMATCH' && /Expected "testnet" but wallet is connected to "mainnet"/.test(error.message));
  assert.equal(calls.sign.length, 0);
});

test('signs nothing for another account or without a connection', async () => {
  const { joey, calls } = fakeJoey();
  const adapter = adapterFor(joey);
  await rejects(adapter.signAndSubmit(payment), 'NOT_CONNECTED');
  await adapter.connect({ network: 'testnet' });
  await rejects(adapter.signAndSubmit({ ...payment, Account: SHOP }), 'SIGN_FAILED');
  assert.equal(calls.sign.length, 0);
});

test('reports a declined signature as the user\'s choice', async () => {
  const adapter = adapterFor(fakeJoey({ refuseSign: refusal(4001) }).joey);
  await adapter.connect({ network: 'testnet' });
  await assert.rejects(adapter.signAndSubmit(payment), (error) => error.code === 'SIGN_REJECTED' && error.category === 'USER_ACTION');
});

test('a submission with a hash goes to the page, whatever its preliminary result, unless it is malformed', async () => {
  // Preliminary results are not final (xrpl.org, "Finality of Results"): only tem never makes it into a ledger.
  for (const engine of ['tesSUCCESS', 'terQUEUED', 'tecPATH_DRY', 'tefPAST_SEQ', 'telINSUF_FEE_P', undefined]) {
    const adapter = adapterFor(fakeJoey({ answer: { hash: HASH, engine_result: engine } }).joey);
    await adapter.connect({ network: 'testnet' });
    assert.equal((await adapter.signAndSubmit(payment)).hash, HASH, String(engine));
  }
  for (const answer of [{ hash: HASH, engine_result: 'temBAD_AMOUNT' }, { engine_result: 'tesSUCCESS' }, null]) {
    const adapter = adapterFor(fakeJoey({ answer }).joey);
    await adapter.connect({ network: 'testnet' });
    await rejects(adapter.signAndSubmit(payment), 'SIGN_FAILED');
  }
});

test('offers neither signing alone nor message signing', async () => {
  const adapter = adapterFor(fakeJoey().joey);
  assert.deepEqual(adapter.capabilities, { sign: false, signAndSubmit: true, signMessage: false });
  await rejects(adapter.sign(payment), 'UNSUPPORTED_METHOD');
  await rejects(adapter.signMessage('hello'), 'UNSUPPORTED_METHOD');
});

test('works inside XRPL Connect\'s WalletManager the way wallets.js uses it', async () => {
  const { joey, calls } = fakeJoey();
  const manager = new lib.WalletManager({ adapters: [adapterFor(joey)], network: 'testnet', autoConnect: false });
  const available = await manager.getAvailableWallets();
  assert.deepEqual(available.map((adapter) => adapter.id), ['joey']);
  const account = await manager.connect('joey', { network: 'testnet' });
  assert.equal(account.network.id, 'testnet');
  const submitted = await manager.signAndSubmit({ ...payment, Account: account.address });
  assert.equal(submitted.hash, HASH);
  assert.equal(calls.sign.length, 1);
  await manager.disconnect();
});

/*
 * When is a connection still the one to pay with? While Joey grants the site
 * access, still offers the connected account and is on the connected chain.
 * Every way Joey ends one is told to XRPL Connect, so the next click asks Joey
 * again instead of reusing a connection Joey no longer honours.
 */
async function connectedWithEars(options) {
  const { joey, calls } = fakeJoey(options);
  const adapter = adapterFor(joey);
  const told = [];
  adapter.on('disconnect', () => told.push('disconnect'));
  await adapter.connect({ network: 'testnet' });
  return { joey, calls, adapter, told };
}

test('asked for no network, connects first and only then reads Joey\'s network', async () => {
  // A site without access may not read it (4100): reading first never opened the approval.
  const { joey, calls } = fakeJoey({ chain: 'xrpl:1' });
  const account = await adapterFor(joey).connect();
  assert.deepEqual(calls.connect, [undefined]);
  assert.equal(account.network.id, 'testnet');
});

test('the owner revoked the site in Joey: the connection is over and XRPL Connect is told', async () => {
  const { joey, adapter, told } = await connectedWithEars();
  joey.granted = false;
  joey.emit('disconnect', { reason: 'revoked' });
  assert.deepEqual(told, ['disconnect']);
  assert.equal(await adapter.getAccount(), null);
  assert.equal(joey.listening(), 0, 'no listener left on the provider');
});

test('Joey no longer offers the connected account: over; still offers it: kept', async () => {
  for (const [accounts, over] of [[[], true], [[{ address: SHOP }], true], [[SHOP], true], [[{ address: CUSTOMER }, { address: SHOP }], false], [[CUSTOMER], false]]) {
    const { joey, adapter, told } = await connectedWithEars();
    joey.emit('accountsChanged', accounts);
    assert.equal(told.length, over ? 1 : 0, JSON.stringify(accounts));
    assert.equal((await adapter.getAccount()) === null, over, JSON.stringify(accounts));
  }
});

test('Joey switched to another network: over; the same one: kept', async () => {
  for (const [network, over] of [[{ chain: 'xrpl:0' }, true], [null, true], [{ chain: 'xrpl:1' }, false]]) {
    const { joey, adapter, told } = await connectedWithEars();
    joey.emit('networkChanged', network);
    assert.equal(told.length, over ? 1 : 0, JSON.stringify(network));
    assert.equal((await adapter.getAccount()) === null, over, JSON.stringify(network));
  }
});

test('access ended without an event: signing finds out, signs nothing, and XRPL Connect is told', async () => {
  const { joey, calls, adapter, told } = await connectedWithEars();
  joey.granted = false;
  await rejects(adapter.signAndSubmit(payment), 'NOT_CONNECTED');
  assert.equal(calls.sign.length, 0);
  assert.deepEqual(told, ['disconnect']);
  assert.equal(await adapter.getAccount(), null);
});

test('the page disconnecting stops listening to Joey and tells nobody', async () => {
  for (const legacyOn of [false, true]) {
    const { joey, adapter, told } = await connectedWithEars({ legacyOn });
    assert.equal(joey.listening(), 3);
    await adapter.disconnect();
    assert.equal(joey.listening(), 0, legacyOn ? 'removeListener' : 'unsubscribe function');
    joey.emit('disconnect', {});
    assert.deepEqual(told, []);
  }
});

test('connecting again does not pile up listeners on Joey', async () => {
  const { joey, adapter } = await connectedWithEars();
  await adapter.connect({ network: 'testnet' });
  await adapter.connect({ network: 'testnet' });
  assert.equal(joey.listening(), 3);
});

test('inside WalletManager: after Joey revoked the site, the next connect asks Joey again', async () => {
  const { joey, calls } = fakeJoey();
  const manager = new lib.WalletManager({ adapters: [adapterFor(joey)], network: 'testnet', autoConnect: false });
  await manager.connect('joey', { network: 'testnet' });
  joey.granted = false;
  joey.emit('disconnect', { reason: 'revoked' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.connected, false);
  await manager.connect('joey', { network: 'testnet' });
  assert.equal(calls.connect.length, 2);
  const submitted = await manager.signAndSubmit({ ...payment, Account: CUSTOMER });
  assert.equal(submitted.hash, HASH);
  await manager.disconnect();
});
