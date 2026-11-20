/**
 * What the page does with the server's answers: `ld:amount` only when the
 * amount to send changes, and an answer that a newer one has overtaken is
 * dropped instead of turning the page back.
 *
 * A fake root is enough, as in chain.test.js: the page touches only what it
 * finds, and here it finds the amount and, for the check button, the form.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { startPaymentPage } from '../src/payment-page.js';

function fakePage({ amount = '0.74791', state = 'waiting', pollUrl = null } = {}) {
  const attributes = { 'data-ld-state': state, 'data-ld-poll-url': pollUrl };
  const amountEl = { textContent: amount };
  const form = { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
  const success = { hidden: true, querySelector: () => null, querySelectorAll: () => [] };
  const amounts = [];
  const root = {
    amountEl,
    form,
    amounts,
    getAttribute: (name) => attributes[name] ?? null,
    setAttribute: (name, value) => { attributes[name] = value; },
    querySelector: (selector) => {
      if (selector === '[data-ld-amount]') return amountEl;
      if (selector === '[data-ld-check-form]') return form;
      if (selector === '[data-ld-success]') return success;
      return null;
    },
    querySelectorAll: () => [],
    addEventListener() {},
    dispatchEvent(event) {
      if (event.type === 'ld:amount') amounts.push(event.detail.amount);
    },
  };
  return root;
}

const partial = (shortfall) => ({ schema_version: 1, state: 'partial', base_asset: 'XRP', amount_requested: 0.74791, amount_paid: 0.74791 - shortfall, shortfall, seconds_left: null });
const settled = { schema_version: 1, state: 'settled', base_asset: 'XRP', amount_requested: 0.74791, amount_paid: 0.74791, shortfall: null, seconds_left: null };

/** fetch() answers in the order the test resolves them, not in the order they were asked. */
function controlledFetch() {
  const pending = [];
  const fetch = () => new Promise((resolve) => {
    pending.push((payload) => resolve({ ok: true, json: async () => payload }));
  });
  return { fetch, pending };
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

function withFetch(fetch, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  return Promise.resolve(run()).finally(() => { globalThis.fetch = original; });
}

/* ---- B1: ld:amount only on a change ---- */

test('two answers with the same shortfall as the page shows fire no ld:amount', async () => {
  const root = fakePage({ amount: '0.44791', state: 'partial' });
  await withFetch(async () => ({ ok: true, json: async () => partial(0.44791) }), async () => {
    const page = startPaymentPage(root);
    await page.checkNow();
    await page.checkNow();
    assert.equal(page.amountDue, '0.44791');
  });
  assert.deepEqual(root.amounts, []);
});

test('a changed shortfall fires ld:amount once, with the new amount', async () => {
  const root = fakePage({ amount: '0.44791', state: 'partial' });
  await withFetch(async () => ({ ok: true, json: async () => partial(0.2) }), async () => {
    const page = startPaymentPage(root);
    await page.checkNow();
    await page.checkNow();
    assert.equal(page.amountDue, '0.2');
  });
  assert.deepEqual(root.amounts, ['0.2']);
  assert.equal(root.amountEl.textContent, '0.2');
});

test('waiting, then partial: one ld:amount — the reload before a wallet payment stays', async () => {
  const root = fakePage({ amount: '0.74791', state: 'waiting' });
  await withFetch(async () => ({ ok: true, json: async () => partial(0.44791) }), async () => {
    const page = startPaymentPage(root);
    await page.checkNow();
    await page.checkNow();
    assert.equal(page.state, 'partial');
  });
  assert.deepEqual(root.amounts, ['0.44791']);
});

/* ---- B3: an overtaken answer is dropped ---- */

test('an older answer arriving after a newer one does not turn the amount back', async () => {
  const root = fakePage({ amount: '0.74791', state: 'waiting' });
  const { fetch, pending } = controlledFetch();
  await withFetch(fetch, async () => {
    const page = startPaymentPage(root);
    const a = page.checkNow();
    const b = page.checkNow();
    pending[1](partial(0.2));
    await b;
    pending[0](partial(0.5));
    await a;
    assert.equal(page.amountDue, '0.2');
  });
  assert.deepEqual(root.amounts, ['0.2']);
});

test('settled stays settled when an older partial answer arrives after it', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const root = fakePage({ state: 'waiting', pollUrl: '/poll' });
    const { fetch, pending } = controlledFetch();
    await withFetch(fetch, async () => {
      startPaymentPage(root);
      mock.timers.tick(8000); // the background poll is in flight
      root.form.listeners.submit({ preventDefault() {} }); // the customer checks
      pending[1](settled);
      await settle();
      pending[0](partial(0.5));
      await settle();
      assert.equal(root.getAttribute('data-ld-state'), 'settled');
      mock.timers.tick(8000);
      assert.equal(pending.length, 2, 'no poll was scheduled after settled');
    });
  } finally {
    mock.timers.reset();
  }
});

test('answers in the order they were asked are both applied', async () => {
  const root = fakePage({ amount: '0.74791', state: 'waiting' });
  const { fetch, pending } = controlledFetch();
  await withFetch(fetch, async () => {
    const page = startPaymentPage(root);
    const a = page.checkNow();
    const b = page.checkNow();
    pending[0](partial(0.5));
    await a;
    pending[1](partial(0.2));
    await b;
    assert.equal(page.amountDue, '0.2');
  });
  assert.deepEqual(root.amounts, ['0.5', '0.2']);
});

test('a newer request that failed does not drop an older answer that arrived', async () => {
  const root = fakePage({ amount: '0.74791', state: 'waiting' });
  const pending = [];
  const fetch = () => new Promise((resolve) => { pending.push(resolve); });
  await withFetch(fetch, async () => {
    const page = startPaymentPage(root);
    const a = page.checkNow();
    const b = page.checkNow();
    pending[1]({ ok: false, json: async () => null }); // the newer one gets a 503
    await b;
    pending[0]({ ok: true, json: async () => partial(0.2) });
    await a;
    assert.equal(page.amountDue, '0.2');
  });
  assert.deepEqual(root.amounts, ['0.2']);
});
