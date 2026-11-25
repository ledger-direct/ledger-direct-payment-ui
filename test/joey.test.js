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

/** The extension, on `chain`; `refuse` makes connect or sign fail with that error. */
function fakeJoey(options = {}) {
  const { chain = 'xrpl:1', refuseConnect, refuseSign } = options;
  const calls = { connect: [], sign: [] };
  const joey = {
    isJoey: true,
    chain,
    async connect(params) {
      calls.connect.push(params);
      if (refuseConnect) throw refuseConnect;
      return { accounts: [{ address: CUSTOMER }], chain: joey.chain };
    },
    async getNetwork() {
      return { chain: joey.chain, networkId: Number(joey.chain.split(':')[1]), name: 'whatever' };
    },
    async signAndSubmitTransaction(params) {
      calls.sign.push(params);
      if (refuseSign) throw refuseSign;
      return 'answer' in options ? options.answer : { tx_json: params.tx_json, tx_blob: '1200', hash: HASH, engine_result: 'tesSUCCESS', engine_result_message: 'ok' };
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
  await rejects(adapter.signAndSubmit(payment), 'NETWORK_MISMATCH');
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
