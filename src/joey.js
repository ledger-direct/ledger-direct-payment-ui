/**
 * Joey Wallet's browser extension as an XRPL Connect adapter. XRPL Connect has
 * none yet (1.0.0); Joey's own SDK is not needed: the extension injects its
 * provider as `window.xrpl.joey` (alias `window.joey`), and that is what this
 * adapter talks to. Its calls were tried by hand against the extension on the
 * XRPL testnet on 2026-11-25, from a payment page: XRP and RLUSD, both settled.
 *
 * What the provider does, as observed and as Joey documents it:
 * - `connect({ chain })` asks the owner and answers `{ accounts: [{ address }], chain }`;
 *   `getNetwork()` answers `{ chain, networkId, name }`. Chains are CAIP-2:
 *   `xrpl:0` mainnet, `xrpl:1` testnet, `xrpl:2` devnet. No Xahau.
 * - `signAndSubmitTransaction({ tx_json, account, chain, autofill })` waits until
 *   the owner confirms (half a minute is normal, so there is no time limit here)
 *   and answers once the wallet submitted, with `hash` and the preliminary
 *   `engine_result` — not once the ledger validated. The page asks the server
 *   anyway: paid is only what the server finds on the ledger.
 * - Errors carry EIP-1193 codes: 4001 the owner declined, 4901/4902 another network.
 *
 * The network is the wallet's choice, made in the wallet. The adapter checks it
 * on connect and again before signing, and refuses a payment on another network
 * than the page's: an address exists on every network, so a mismatch would
 * otherwise pay on the wrong one.
 *
 * Errors are XRPL Connect's own (`createWalletError`), so wallets.js reports a
 * refusal, a wrong network or a missing wallet the same way for every wallet.
 */

/** The engine results under which a submitted transaction may still be applied. */
const SUBMITTED = ['tesSUCCESS', 'terQUEUED'];

/** The injected provider, or null. Looked up on every call: the extension may inject after the page started. */
export function findJoey(scope = globalThis) {
    const provider = (scope && scope.xrpl && scope.xrpl.joey) || (scope && scope.joey) || null;
    return provider && typeof provider.connect === 'function' && typeof provider.signAndSubmitTransaction === 'function' ? provider : null;
}

/**
 * @param {object} lib the xrpl-connect module (createWalletError, resolveNetwork, isStandardNetworkId)
 * @param {{ provider?: () => object | null }} options `provider` replaces the lookup on the window, for tests
 */
export function createJoeyAdapter(lib, options = {}) {
    const errors = lib.createWalletError;
    const providerOf = options.provider || (() => findJoey());
    const NAME = 'Joey';

    let account = null;
    let chain = null;
    let generation = 0;

    function provider() {
        const found = providerOf();
        if (!found) {
            throw errors.notInstalled(NAME);
        }
        return found;
    }

    function code(error) {
        return error && typeof error === 'object' ? Number(error.code) : NaN;
    }

    function isWalletError(error) {
        return typeof lib.isWalletError === 'function' ? lib.isWalletError(error) : !!(error && error.category);
    }

    /**
     * The standard network asked for, with its CAIP-2 chain; Joey knows no other.
     * Asked for none: the one the wallet is on (the payment page always asks).
     */
    async function requested(network, joey) {
        if (network === undefined) {
            const now = await liveChain(joey);
            const standard = ['mainnet', 'testnet', 'devnet'].map((id) => lib.resolveNetwork(id)).find((info) => info.walletConnectId === now);
            if (!standard) {
                throw errors.networkNotSupported(now || 'unknown', NAME);
            }
            return standard;
        }
        if (typeof network === 'string' && !lib.isStandardNetworkId(network)) {
            throw errors.networkNotSupported(network, NAME);
        }
        const info = lib.resolveNetwork(network);
        if (!info.walletConnectId) {
            throw errors.networkNotSupported(info.id, NAME);
        }
        return info;
    }

    /** The chain the wallet is on now. */
    async function liveChain(joey) {
        const live = await joey.getNetwork();
        return live && typeof live.chain === 'string' ? live.chain : '';
    }

    return {
        id: 'joey',
        name: NAME,
        url: 'https://joeywallet.xyz',
        capabilities: { sign: false, signAndSubmit: true, signMessage: false },

        async isAvailable() {
            return providerOf() !== null;
        },

        async connect(connectOptions = {}) {
            const mine = ++generation;
            try {
                const joey = provider();
                const network = await requested(connectOptions.network, joey);
                const answer = await joey.connect({ chain: network.walletConnectId });
                const now = await liveChain(joey);
                if (mine !== generation) {
                    throw errors.notConnected();
                }
                if ((answer && answer.chain) !== network.walletConnectId || now !== network.walletConnectId) {
                    throw errors.networkMismatch(network.id, now || (answer && answer.chain) || 'unknown');
                }
                const first = answer && Array.isArray(answer.accounts) ? answer.accounts[0] : null;
                if (!first || typeof first.address !== 'string' || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(first.address)) {
                    throw new Error('Joey returned no account');
                }
                chain = network.walletConnectId;
                account = { address: first.address, publicKey: first.publicKey, network };
                return account;
            } catch (error) {
                if (isWalletError(error)) throw error;
                if (code(error) === 4001) throw errors.connectionRejected(NAME, error);
                if (code(error) === 4901 || code(error) === 4902) {
                    const asked = connectOptions.network;
                    throw errors.networkMismatch(typeof asked === 'string' ? asked : (asked && asked.id) || 'unknown', 'another network');
                }
                throw errors.connectionFailed(NAME, error);
            }
        },

        /** Forgets the connection here. Joey keeps the site's permission; revoking it is the owner's choice, in Joey. */
        async disconnect() {
            generation += 1;
            account = null;
            chain = null;
        },

        async getAccount() {
            return account;
        },

        async getNetwork() {
            if (!account) {
                throw errors.notConnected();
            }
            return account.network;
        },

        async sign() {
            throw errors.unsupportedMethod('Joey is used to sign and submit; signing alone is not offered here');
        },

        async signMessage() {
            throw errors.unsupportedMethod('Joey message signing is not offered here');
        },

        async signAndSubmit(transaction) {
            if (!account) {
                throw errors.notConnected();
            }
            const mine = generation;
            const from = account.address;
            const on = chain;
            try {
                if (transaction.Account !== undefined && transaction.Account !== from) {
                    throw new Error('the transaction is for another account than the connected one');
                }
                const joey = provider();
                // The owner may have switched networks in Joey since connecting.
                const now = await liveChain(joey);
                if (now !== on) {
                    throw errors.networkMismatch(account.network.id, now || 'unknown');
                }
                if (mine !== generation) {
                    throw errors.notConnected();
                }
                const result = await joey.signAndSubmitTransaction({
                    tx_json: { ...transaction, Account: from },
                    account: from,
                    chain: on,
                    autofill: true,
                });
                if (!result || typeof result.hash !== 'string' || result.hash === '') {
                    throw new Error('Joey returned no transaction hash');
                }
                if (result.engine_result !== undefined && !SUBMITTED.includes(result.engine_result)) {
                    throw new Error('Joey submitted the transaction, the ledger answered ' + result.engine_result);
                }
                return { hash: result.hash, tx_blob: result.tx_blob, tx_json: result.tx_json };
            } catch (error) {
                if (isWalletError(error)) throw error;
                if (code(error) === 4001) throw errors.signRejected(error);
                if (code(error) === 4901 || code(error) === 4902) throw errors.networkMismatch(account ? account.network.id : 'unknown', 'another network');
                throw errors.signFailed(error);
            }
        },
    };
}
