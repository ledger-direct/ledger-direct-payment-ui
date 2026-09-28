/**
 * @ledger-direct/payment-ui — the LedgerDirect payment page, framework-free.
 *
 * A platform with a bundler imports from here; `startPaymentPage(root)` wires
 * the states, the QR code and the browser wallets together. Platforms without a
 * bundler use dist/ (see README.md).
 */
export { startPaymentPage } from './payment-page.js';
export { startQr } from './qr.js';
export { startWallets } from './wallets.js';
