/**
 * The QR code: one code with the payment request the server put into
 * `data-ld-payment-uri`. This module only renders; the request itself is
 * built and unit-tested on the server (PaymentUri), so every platform
 * encodes the same thing.
 *
 * When a partial payment turns the amount to send into the shortfall, the
 * page announces the new amount (`ld:amount`) and the request is rewritten
 * with it — a string replacement of the `amount` parameter, not arithmetic.
 * A request without an amount stays without one.
 */
import qrcode from 'qrcode-generator';

const CELL_SIZE = 4;

function withAmount(uri, amount) {
    let url;
    try {
        url = new URL(uri);
    } catch {
        return uri;
    }
    if (!url.searchParams.has('amount') || !amount) {
        return uri;
    }
    url.searchParams.set('amount', amount);
    return url.toString();
}

function render(host, text, label) {
    const code = qrcode(0, 'M');
    code.addData(text);
    code.make();
    host.innerHTML = code.createSvgTag({ cellSize: CELL_SIZE, margin: 0, scalable: true });
    const svg = host.querySelector('svg');
    if (svg) {
        svg.setAttribute('role', 'img');
        if (label) {
            svg.setAttribute('aria-label', label);
        }
    }
}

export function startQr(root) {
    const host = root.querySelector('[data-ld-qr]');
    let uri = root.getAttribute('data-ld-payment-uri') || '';
    if (!host || !uri) {
        return;
    }
    const label = host.getAttribute('data-ld-qr-label') || '';

    render(host, uri, label);

    root.addEventListener('ld:amount', (event) => {
        const next = withAmount(uri, event.detail && event.detail.amount);
        if (next !== uri) {
            uri = next;
            root.setAttribute('data-ld-payment-uri', uri);
            render(host, uri, label);
        }
    });
}

/**
 * A QR code for one field — the receiving address or the destination tag —
 * in a dialog next to its copy button, for a wallet whose scanner fills one
 * field at a time. The values are the server-rendered ones the copy buttons
 * read (`data-value` of `[data-ld-account]`, `[data-ld-tag]`); the dialog and
 * every word in it are the template's (`[data-ld-qr-dialog]`).
 */
export function startFieldQr(root) {
    const dialog = root.querySelector('[data-ld-qr-dialog]');
    if (!dialog) {
        return;
    }
    const code = dialog.querySelector('[data-ld-qr-dialog-code]');
    const shown = dialog.querySelector('[data-ld-qr-dialog-value]');

    function close() {
        if (typeof dialog.close === 'function') {
            dialog.close();
        } else {
            dialog.removeAttribute('open');
        }
    }

    root.addEventListener('click', (event) => {
        const button = event.target.closest('[data-ld-qr-show]');
        if (!button) {
            return;
        }
        const kind = button.getAttribute('data-ld-qr-show');
        const source = root.querySelector('[data-ld-' + kind + ']');
        const value = source ? (source.getAttribute('data-value') || source.textContent).trim() : '';
        if (!value || !code) {
            return;
        }
        render(code, value, button.getAttribute('aria-label') || '');
        if (shown) {
            shown.textContent = value;
        }
        dialog.querySelectorAll('[data-ld-qr-dialog-title]').forEach((el) => {
            el.hidden = el.getAttribute('data-ld-qr-dialog-title') !== kind;
        });
        if (typeof dialog.showModal === 'function') {
            dialog.showModal();
        } else {
            dialog.setAttribute('open', '');
        }
    });

    dialog.addEventListener('click', (event) => {
        // The close button, or a click on the backdrop (the dialog itself, outside its content).
        if (event.target === dialog || event.target.closest('[data-ld-qr-dialog-close]')) {
            close();
        }
    });
}
