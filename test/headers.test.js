/**
 * The poll carries the platform's own headers: options.headers for a build
 * that starts the page itself, data-ld-poll-headers for the classic build.
 * A headless front end on Shopware needs sw-access-key there. The fixed
 * Accept and X-Requested-With stay and are not overridden.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { startPaymentPage } from '../src/payment-page.js';

// The page schedules its next poll with setTimeout; faked timers keep that
// from running against the real fetch after a test and from holding the
// process open.
mock.timers.enable({ apis: ['setTimeout'] });

function fakePage(attributes) {
  return {
    getAttribute: (name) => attributes[name] ?? null,
    setAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    dispatchEvent() {},
  };
}

const waiting = { schema_version: 1, state: 'waiting', base_asset: 'XRP', amount_requested: 1, amount_paid: 0, shortfall: 1, seconds_left: 100 };

async function pollWith(attributes, options) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => waiting };
  };
  try {
    const page = startPaymentPage(fakePage({ 'data-ld-poll-url': '/status?code=secret', 'data-ld-state': 'waiting', ...attributes }), options);
    await page.checkNow();
    return calls[0];
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('without the option or the attribute the poll is as it always was', async () => {
  const { url, init } = await pollWith({}, {});
  assert.equal(url, '/status?code=secret');
  assert.equal(init.credentials, 'same-origin');
  assert.deepEqual(init.headers, { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' });
});

test('options.headers go with every poll, on top of the fixed ones', async () => {
  const { init } = await pollWith({}, { headers: { 'sw-access-key': 'SWSCKEY', 'sw-language-id': 'abc' } });
  assert.deepEqual(init.headers, {
    'sw-access-key': 'SWSCKEY',
    'sw-language-id': 'abc',
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  });
  assert.equal(init.credentials, 'same-origin', 'access is the secret in the URL, not a cookie');
});

test('the classic build reads data-ld-poll-headers as JSON', async () => {
  const { init } = await pollWith({ 'data-ld-poll-headers': '{"sw-access-key":"SWSCKEY"}' }, {});
  assert.equal(init.headers['sw-access-key'], 'SWSCKEY');
  assert.equal(init.headers.Accept, 'application/json');
});

test('the fixed headers are not overridden, and an unreadable attribute counts as none', async () => {
  const overriding = await pollWith({ 'data-ld-poll-headers': '{"Accept":"text/html"}' }, { headers: { 'X-Requested-With': 'curl' } });
  assert.equal(overriding.init.headers.Accept, 'application/json');
  assert.equal(overriding.init.headers['X-Requested-With'], 'XMLHttpRequest');

  for (const broken of ['not json', '["sw-access-key"]', '42']) {
    const { init } = await pollWith({ 'data-ld-poll-headers': broken }, {});
    assert.deepEqual(init.headers, { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, broken);
  }
});
