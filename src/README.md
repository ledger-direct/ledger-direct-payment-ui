# The LedgerDirect payment page — markup contract

`payment-page.js`, `qr.js`, `wallets.js` and `payment-page.css` are the payment page's behaviour and
design for **every** LedgerDirect plugin. They import nothing from any shop system or framework:
`fetch()` and the DOM are all they use. A platform supplies the markup described here and its
translated texts, and starts the page:

- **with a bundler** (Shopware's webpack): `import { startPaymentPage } from '@ledger-direct/payment-ui'`
  — the wallet library becomes a code-split chunk of the platform's build;
- **without one** (PrestaShop, WooCommerce, Magento): copy `dist/payment-page.js` and `dist/payment-page.css`
  into the module and load them as classic assets; `dist/payment-page.js` starts every `[data-ld-page]` on
  `DOMContentLoaded`. Copy `dist/wallets.js` too and name its URL in `data-ld-wallets-src`; it is fetched
  by a native `import()` only when the customer opens the wallet list.

The tests keep the boundary: nothing in `src/` may mention `PluginManager`, `DomAccess`, `HttpClient` or
`jQuery`, and every `data-ld-*` attribute the sources read must be documented here.

## What the page must be without JavaScript

Every sentence a customer reads is server-rendered. Every state block exists in the markup and the
server decides which one starts visible. The check button is a plain `<form method="post">` back to
the payment page, which syncs on render. The refresh button is a form too. The script only switches
blocks, inserts numbers and polls.

## Markup contract

Root element `.ld-page` with:

| Attribute | Value |
|---|---|
| `data-ld-state` | one of `waiting`, `partial`, `wrong_asset`, `expired` (a settled order never renders the page) |
| `data-ld-poll-url` | the status endpoint for this order, secret included; absent → no polling |
| `data-ld-seconds-left` | integer, only in `waiting` with an expiry |
| `data-ld-quote-seconds` | the quote's full validity, for the countdown bar |
| `data-ld-asset` | the asset label as shown next to amounts (`XRP`, `RLUSD`, `USDC`) |
| `data-ld-network` | `mainnet` or `testnet` |
| `data-ld-explorer-base` | URL prefix a transaction hash is appended to |
| `data-ld-payment-uri` | the payment request the QR code encodes (built by the server; absent → no QR) |
| `data-ld-amount-drops` | XRP only: the requested amount in drops, as a string |
| `data-ld-currency`, `data-ld-issuer` | tokens only: the quoted currency hex code and issuer |
| `data-ld-xaman-key`, `data-ld-wc-project` | optional wallet-app identifiers |
| `data-ld-amount-requested` | the requested amount as a plain decimal, whatever `[data-ld-amount]` shows (in `partial` that is the shortfall); read by the end-to-end harness |
| `data-ld-wallets-src` | classic build only: absolute URL of `dist/wallets.js`; absent → no browser wallets |

Inside the root:

| Selector | Meaning |
|---|---|
| `[data-ld-open]` | everything shown while the order waits; hidden when the poll reports `settled` |
| `[data-ld-block="<state>"]` | one block per state; the script hides all but the current |
| `[data-ld-status-for="<state>"]` | the status line sentence per state |
| `[data-ld-amount]` | the amount to send; in `partial` the script replaces it with the shortfall |
| `[data-ld-amount-label] [data-ld-label="due|remaining"]` | the two labels above the amount |
| `[data-ld-fiat] [data-ld-fiat-for="full|partial"]` | the fiat line for the two cases |
| `[data-ld-paid]`, `[data-ld-shortfall]`, `[data-ld-progress]` | inside a state block: numbers and the progress bar the poll fills |
| `[data-ld-timer]`, `[data-ld-countdown]`, `[data-ld-timer-bar]` | the countdown |
| `[data-ld-account]`, `[data-ld-tag]`, `[data-ld-issuer]` | copy sources (`data-value` or text) |
| `[data-copy="amount|account|tag|issuer"]` | copy buttons, with `[data-ld-copy-label="idle|done"]` children |
| `[data-ld-check-form]`, `[data-ld-check]`, `[data-ld-check-label="idle|busy"]`, `[data-ld-toast]` | the check button, its labels and the "nothing found yet" hint |
| `[data-ld-qr-details]`, `[data-ld-qr]`, `[data-ld-qr-box]`, `[data-ld-qr-void]` | the QR code, collapsible on narrow screens, blurred in `expired`; `[data-ld-qr]` may carry `data-ld-qr-label`, the accessible name of the rendered code |
| `[data-ld-wallet-section]` | browser-wallet UI; hidden in `expired` and, unless `[data-ld-wallet-mobile]`, on narrow screens |
| `[data-ld-wallet-desktop]` with `[data-ld-wallet-toggle]`, `[data-ld-wallets]`, `[data-ld-wallet-list]` | the "pay with a browser wallet" button, the list it opens, and the element the detected wallets are rendered into; `[data-ld-wallet-status="loading|none|hint"]` are the three sentences around the list |
| `[data-ld-wallet-app]` with `data-ld-wallet-id="xaman|walletconnect"` | the phone's "open in wallet app" button, rendered only when the merchant configured that identifier |
| `[data-ld-wallet-message]` and `[data-ld-wallet-text="<key>"]` | where the module's messages appear, and the hidden server-rendered sentences it picks from: `found`, `confirm`, `submitted`, `error-unavailable`, `error-network`, `error-mismatch` (with `%network%`), `error-other`, `network-mainnet`, `network-testnet` |
| `[data-ld-success]` | the success view: `[data-ld-settled-amount]`, `[data-ld-hash-row]` with `[data-ld-hash]`, `[data-ld-redirect-link]`, `[data-ld-redirect-count]` |

The end-to-end harness (`ledger-direct-e2e`) reads the page through this contract only: `data-ld-state`,
`data-ld-amount-requested` and `data-ld-asset` on the root, `[data-ld-account]` and `[data-ld-tag]` by their
`data-value`. Platform-specific ids are not part of the contract.

## Status payload

`PaymentStatus::toArray()` from the core plus the platform's `redirect`:

```json
{"schema_version":1,"state":"partial","base_asset":"XRP","amount_requested":0.85635,
 "amount_paid":0.5,"shortfall":0.35635,"seconds_left":null}
```

Only a `redirect` or `settled` stops the polling. Amounts are inserted exactly as received —
a number as `String(n)`, a token amount by its `value` — never rounded or reformatted in the browser.

## Events

The root dispatches `ld:state` (`detail.state`) and `ld:amount` (`detail.amount`) so an optional
module (QR rendering, wallets) can follow the page without the page knowing about it.
