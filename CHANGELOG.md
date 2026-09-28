# 0.1.1

- Relative imports in `src/payment-page.js` name their file extension (`./qr.js`, `./wallets.js`). The
  package is `"type": "module"`, so a bundler that follows the ESM rules — Shopware's webpack does —
  refused the extension-less form. `dist/` is unchanged in behaviour.

# 0.1.0

First release, lifted from the Shopware plugin 1.4.0 (`src/Resources/app/storefront/src/payment-ui/`)
unchanged in behaviour:

- `payment-page.js`: the five payment states, countdown, polling, copy buttons, success view
- `qr.js`: the QR code from the server's payment request, rewritten on a partial payment
- `wallets.js`: browser wallets over XRPL Connect 1.0.0-rc.2 — Crossmark, GemWallet, MetaMask Snap, Ledger,
  Otsu, Xyra, and Xaman / WalletConnect with a merchant identifier; connection reuse, network check, errors by
  category
- `payment-page.css`: the design, one accent colour, dark mode by `prefers-color-scheme`

New for the package:

- `startWallets(root, { loadLibrary })` takes the wallet-library loader from outside; the bundler default is
  `import('xrpl-connect')`, the classic build imports the URL in `data-ld-wallets-src`
- `dist/`: `payment-page.js` (classic script), `wallets.js` (ES module with xrpl-connect and xrpl),
  `payment-page.css`
- Contract additions: `data-ld-amount-requested` and `data-ld-wallets-src` on the root; `data-value` on
  `[data-ld-account]` and `[data-ld-tag]`
- Tests for the boundary (no shop system in `src/`) and the contract's coverage; a fixture for all states
