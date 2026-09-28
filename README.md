# @ledger-direct/payment-ui

The LedgerDirect payment page — the page a customer sees after checkout to pay an order on the XRP
Ledger — as one framework-free implementation shared by every LedgerDirect plugin (Shopware, PrestaShop,
WooCommerce, Magento). Five payment states, a countdown, polling of the platform's status endpoint, copy
buttons, a QR code with address, destination tag and amount, and browser wallets over
[XRPL Connect](https://github.com/XRPL-Commons/xrpl-connect).

The package holds the two halves that are the same everywhere: **behaviour** (`src/*.js`) and **design**
(`src/payment-page.css`). What differs per platform stays in the plugin: the template that renders the
markup contract with the shop's translated texts, and the controller that supplies the values. Nothing a
customer reads is in this package.

## Markup contract

[`src/README.md`](src/README.md) — the `data-ld-*` attributes a template renders, the blocks per state, the
events, and the status payload the page polls (`PaymentStatus::toArray()` from `hardcastle/ledger-direct-core`
plus the platform's `redirect`). A platform that renders the contract gets the page.

## Using it

**With a bundler** (Shopware's storefront build):

```js
import { startPaymentPage } from '@ledger-direct/payment-ui';
startPaymentPage(document.querySelector('[data-ld-page]'));
```

```scss
@import '@ledger-direct/payment-ui/src/payment-page';
```

The wallet library becomes a code-split chunk of your build, loaded when the customer opens the wallet list.

**Without a bundler** (PrestaShop, WooCommerce, Magento): copy `dist/payment-page.js`, `dist/payment-page.css`
and `dist/wallets.js` into the module and register the first two as ordinary assets. `dist/payment-page.js`
starts every `[data-ld-page]` on `DOMContentLoaded`. Put the URL of `dist/wallets.js` into
`data-ld-wallets-src`; it is fetched by a native `import()` only when needed. `dist/` is committed and tagged,
so a module pins a version by copying it.

| File | Size | Loaded |
|---|---|---|
| `dist/payment-page.js` | ~40 KB | with the page (states, countdown, polling, QR) |
| `dist/wallets.js` | ~1.6 MB | on click, when the customer opens the wallet list |
| `dist/payment-page.css` | ~14 KB | with the page |

## Rules the page keeps

- **Only `settled` or a `redirect` stops the polling.** `partial` and `wrong_asset` keep polling so a top-up is
  noticed; `expired` keeps polling so a late payment is.
- **Nothing is rounded or reformatted in the browser.** Amounts are inserted exactly as the server states them.
- **Every sentence a customer reads comes from the platform's template.** The script switches blocks and
  fills in numbers.
- **Transactions for browser wallets are built from server-rendered values only** — account, tag, the amount in
  drops or the token's currency, issuer and value — and a submitted hash is a hint: paid is what the server
  finds on the ledger.

## Development

```
npm install
npm test          # boundary: no shop system in src/, contract documented
npm run build     # dist/payment-page.js (iife), dist/wallets.js (esm), dist/payment-page.css
npm run serve     # http://localhost:8765/?state=waiting — the fixture, all states, no shop needed
```

The fixture (`test/fixture/`) renders the contract with example values and answers the poll from
`status/<state>.json`; `?state=partial&then=settled` shows the transition into the success view. Browser wallets
work in the fixture too, against whatever extensions the browser has.

`dist/` is committed; CI fails when it is stale.

## License

MIT
