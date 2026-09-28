/**
 * The classic build: one script, loaded with a plain <script> tag, that starts
 * every payment page on the document. For platforms without a bundler.
 *
 * The wallet library is not in this file. It is fetched by a native dynamic
 * import() of the URL the page names in data-ld-wallets-src — the built
 * dist/wallets.js — and only when the customer opens the wallet list. No
 * attribute, no wallets.
 */
import { startPaymentPage } from '../src/index.js';

function start() {
    document.querySelectorAll('[data-ld-page]').forEach((root) => {
        const walletsSrc = root.getAttribute('data-ld-wallets-src');
        startPaymentPage(root, {
            loadLibrary: walletsSrc ? () => import(walletsSrc) : () => Promise.reject(new Error('no wallet library configured')),
        });
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
} else {
    start();
}
