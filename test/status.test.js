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

/*
 * The other half of the rule: an overtaken request that fails — the fetch
 * rejects, or the body is not JSON — is dropped just like one that answers.
 * Read as "nothing new" it would schedule a poll after settled.
 */
for (const [name, failure] of [
  ['the fetch rejects', (resolve, reject) => reject(new TypeError('network'))],
  ['the body is not JSON', (resolve) => resolve({ ok: true, json: async () => { throw new SyntaxError('not JSON'); } })],
]) {
  test(`an overtaken request that fails (${name}) does not restart polling after settled`, async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    try {
      const root = fakePage({ state: 'waiting', pollUrl: '/poll' });
      const pending = [];
      const fetch = () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
      await withFetch(fetch, async () => {
        startPaymentPage(root);
        mock.timers.tick(8000); // the background poll is in flight
        root.form.listeners.submit({ preventDefault() {} });
        pending[1].resolve({ ok: true, json: async () => settled });
        await settle();
        failure(pending[0].resolve, pending[0].reject);
        await settle();
        assert.equal(root.getAttribute('data-ld-state'), 'settled');
        mock.timers.tick(8000);
        assert.equal(pending.length, 2, 'no poll was scheduled after settled');
      });
    } finally {
      mock.timers.reset();
    }
  });
}

/* ---- the page leaves once ---- */

/*
 * The redirect can be single-use: Shopware's finalize URL invalidates its
 * payment token on the first request. A second navigation started before the
 * first has loaded wins and ends on the error page — seen with the button
 * clicked as the countdown ran out.
 */
function settledPage({ secondsLeft = null } = {}) {
  const root = fakePage({ state: 'waiting', pollUrl: '/poll' });
  if (secondsLeft !== null) root.setAttribute('data-ld-seconds-left', String(secondsLeft));
  const countdown = { textContent: '' };
  const listeners = {};
  const link = {
    href: '/account/order',
    addEventListener(type, fn) { listeners[type] = fn; },
    click() {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      listeners.click(event);
      return event.defaultPrevented ? null : this.href;
    },
  };
  const count = { textContent: '' };
  const success = {
    hidden: true,
    querySelector: (selector) => {
      if (selector === '[data-ld-redirect-link]') return link;
      if (selector === '[data-ld-redirect-count]') return count;
      return null;
    },
    querySelectorAll: () => [],
  };
  const rootEvents = {};
  const lookup = root.querySelector;
  root.querySelector = (selector) => {
    if (selector === '[data-ld-success]') return success;
    if (selector === '[data-ld-redirect-link]') return link;
    if (selector === '[data-ld-countdown]') return countdown;
    return lookup(selector);
  };
  root.addEventListener = (type, fn) => { rootEvents[type] = fn; };
  root.link = link;
  root.fire = (type) => rootEvents[type]();
  return root;
}

const finalize = '/payment/finalize-transaction?_sw_payment_token=t';

/** Runs the page with a window whose navigations are counted. */
async function leaving(run) {
  const visits = [];
  const originalWindow = globalThis.window;
  globalThis.window = { location: { set href(url) { visits.push(url); }, get href() { return ''; } } };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    await run(visits);
  } finally {
    mock.timers.reset();
    globalThis.window = originalWindow;
  }
  return visits;
}

test('the button clicked during the countdown is the only navigation', async () => {
  const navigations = [];
  const visits = await leaving(async () => {
    const root = settledPage();
    await withFetch(async () => ({ ok: true, json: async () => ({ ...settled, redirect: finalize }) }), async () => {
      startPaymentPage(root);
      mock.timers.tick(8000);
      await settle();
      mock.timers.tick(4000);
      navigations.push(root.link.click());
      mock.timers.tick(5000);
      navigations.push(root.link.click()); // a second click is not a second request
    });
  });
  assert.deepEqual(visits, []);
  assert.deepEqual(navigations, [finalize, null]);
});

test('the countdown leaves once, even when a wallet asks again after settled', async () => {
  let requests = 0;
  const visits = await leaving(async () => {
    const root = settledPage();
    await withFetch(async () => { requests++; return { ok: true, json: async () => ({ ...settled, redirect: finalize }) }; }, async () => {
      startPaymentPage(root);
      mock.timers.tick(8000);
      await settle();
      root.fire('ld:check'); // the wallet reports its transaction
      await settle();
      mock.timers.tick(5000);
      root.fire('ld:check');
      await settle();
      mock.timers.tick(5000);
    });
  });
  assert.deepEqual(visits, [finalize]);
  assert.equal(requests, 2, 'the poll and the first ld:check; nothing once the page left');
});

test('a redirect for an order that stopped waiting is followed once, and the page stops', async () => {
  const cancelled = { schema_version: 1, state: 'waiting', base_asset: 'XRP', amount_requested: 0.74791, amount_paid: 0, shortfall: null, seconds_left: 3, redirect: '/account/order/edit/1' };
  let requests = 0;
  let root;
  const visits = await leaving(async () => {
    root = settledPage({ secondsLeft: 3 });
    await withFetch(async () => { requests++; return { ok: true, json: async () => cancelled }; }, async () => {
      startPaymentPage(root);
      root.fire('ld:check');
      await settle();
      root.fire('ld:check');
      await settle();
      mock.timers.tick(8000); // the quote would have expired meanwhile
      await settle();
    });
  });
  assert.deepEqual(visits, ['/account/order/edit/1']);
  assert.equal(requests, 1, 'no request once the page left');
  assert.equal(root.getAttribute('data-ld-state'), 'waiting', 'the quote countdown stopped with the page');
});
