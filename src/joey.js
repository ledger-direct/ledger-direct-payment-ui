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

/**
 * A preliminary engine result decides nothing, except a malformed transaction
 * (`tem…`), which no ledger takes unless the protocol changes. Every other
 * result — tes, tec, ter, tef, tel — can still end differently once a ledger
 * is validated (xrpl.org, "Finality of Results"), so a submission with a hash
 * goes to the page as submitted, and the page asks the server.
 */
function neverApplied(engineResult) {
    return typeof engineResult === 'string' && engineResult.startsWith('tem');
}

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
    const STANDARD = ['mainnet', 'testnet', 'devnet'];

    let account = null;
    let chain = null;
    let generation = 0;
    let unwatch = null;
    /** Who XRPL Connect's WalletManager asked to hear about this adapter's events. */
    const listeners = new Map();

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

    /** The standard network asked for, with its CAIP-2 chain; Joey knows no other. */
    function requested(network) {
        if (typeof network === 'string' && !lib.isStandardNetworkId(network)) {
            throw errors.networkNotSupported(network, NAME);
        }
        const info = lib.resolveNetwork(network);
        if (!info.walletConnectId) {
            throw errors.networkNotSupported(info.id, NAME);
        }
        return info;
    }

    /** The standard network whose CAIP-2 chain this is, or undefined. */
    function standardFor(walletChain) {
        return STANDARD.map((id) => lib.resolveNetwork(id)).find((info) => info.walletConnectId === walletChain);
    }

    /** A chain as XRPL Connect names its networks (mainnet, testnet, devnet), for messages; another chain as it is. */
    function named(walletChain) {
        const standard = standardFor(walletChain);
        return standard ? standard.id : walletChain || 'unknown';
    }

    /** The chain the wallet is on now. Only a site with Joey's permission may ask (4100 otherwise). */
    async function liveChain(joey) {
        const live = await joey.getNetwork();
        return live && typeof live.chain === 'string' ? live.chain : '';
    }

    function emit(event, data) {
        (listeners.get(event) || new Set()).forEach((callback) => {
            try {
                callback(data);
            } catch {
                // a listener's failure is not the wallet's
            }
        });
    }

    /** Joey's `on` answers an unsubscribe function; older builds only have removeListener (or off). */
    function subscribe(joey, event, callback) {
        const off = joey.on(event, callback);
        if (typeof off === 'function') {
            return off;
        }
        return () => {
            const remove = typeof joey.off === 'function' ? joey.off : joey.removeListener;
            if (typeof remove === 'function') {
                remove.call(joey, event, callback);
            }
        };
    }

    function stopWatching() {
        if (unwatch) {
            const stop = unwatch;
            unwatch = null;
            stop();
        }
    }

    /** Forgets the connection here, without a word to anyone. */
    function forget() {
        generation += 1;
        account = null;
        chain = null;
        stopWatching();
    }

    /**
     * The connection is over on Joey's side: XRPL Connect is told, so it does not
     * hand the next click a connection Joey no longer honours, and that click asks
     * Joey again.
     */
    function lost() {
        if (!account) {
            return;
        }
        forget();
        emit('disconnect');
    }

    function addressOf(entry) {
        return typeof entry === 'string' ? entry : entry && entry.address;
    }

    /**
     * A connection is the one to pay with while Joey grants the site access, still
     * offers the connected account, and is on the connected chain. Joey tells each
     * change: `disconnect` (access revoked, accounts deleted, wallet reset),
     * `accountsChanged` (empty when revoked), `networkChanged`. Locking Joey ends
     * nothing: requests wait behind its unlock screen.
     */
    function watch(joey) {
        stopWatching();
        if (typeof joey.on !== 'function') {
            return;
        }
        const offs = [
            subscribe(joey, 'disconnect', () => lost()),
            subscribe(joey, 'accountsChanged', (accounts) => {
                if (account && !(Array.isArray(accounts) && accounts.some((entry) => addressOf(entry) === account.address))) {
                    lost();
                }
            }),
            subscribe(joey, 'networkChanged', (network) => {
                if (account && !(network && network.chain === chain)) {
                    lost();
                }
            }),
        ];
        unwatch = () => offs.forEach((off) => {
            try {
                off();
            } catch {
                // the provider may be gone already
            }
        });
    }

    return {
        id: 'joey',
        name: NAME,
        url: 'https://joeywallet.xyz',
        capabilities: { sign: false, signAndSubmit: true, signMessage: false },

        async isAvailable() {
            return providerOf() !== null;
        },

        /**
         * Asks Joey for access on the page's network. Asked for none, on the
         * network Joey is on (the payment page always asks). Joey's network is read
         * only after connect(): a site without access may not ask for it.
         */
        async connect(connectOptions = {}) {
            const mine = ++generation;
            stopWatching();
            account = null;
            chain = null;
            try {
                const joey = provider();
                const asked = connectOptions.network === undefined ? null : requested(connectOptions.network);
                const answer = asked ? await joey.connect({ chain: asked.walletConnectId }) : await joey.connect();
                const now = await liveChain(joey);
                if (mine !== generation) {
                    throw errors.notConnected();
                }
                const network = asked || standardFor(now);
                if (!network) {
                    throw errors.networkNotSupported(now || 'unknown', NAME);
                }
                if ((answer && answer.chain) !== network.walletConnectId || now !== network.walletConnectId) {
                    throw errors.networkMismatch(network.id, named(now || (answer && answer.chain)));
                }
                const first = answer && Array.isArray(answer.accounts) ? answer.accounts[0] : null;
                const address = addressOf(first);
                if (typeof address !== 'string' || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address)) {
                    throw new Error('Joey returned no account');
                }
                chain = network.walletConnectId;
                account = { address, publicKey: first && first.publicKey, network };
                watch(joey);
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
            forget();
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
            const network = account.network;
            const on = chain;
            try {
                if (transaction.Account !== undefined && transaction.Account !== from) {
                    throw new Error('the transaction is for another account than the connected one');
                }
                const joey = provider();
                // The owner may have switched networks in Joey since connecting.
                const now = await liveChain(joey);
                if (mine !== generation) {
                    throw errors.notConnected();
                }
                if (now !== on) {
                    throw errors.networkMismatch(network.id, named(now));
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
                if (neverApplied(result.engine_result)) {
                    throw new Error('Joey submitted the transaction, the ledger refused it as malformed: ' + result.engine_result);
                }
                return { hash: result.hash, tx_blob: result.tx_blob, tx_json: result.tx_json };
            } catch (error) {
                if (isWalletError(error)) throw error;
                if (code(error) === 4001) throw errors.signRejected(error);
                if (code(error) === 4901 || code(error) === 4902) throw errors.networkMismatch(network.id, 'another network');
                if (code(error) === 4100) {
                    // Joey no longer grants this site access and no event said so: the
                    // connection is over, and the next click asks Joey again.
                    if (mine === generation) lost();
                    throw errors.notConnected();
                }
                throw errors.signFailed(error);
            }
        },

        /** For XRPL Connect's WalletManager: `disconnect` when Joey ended the connection. */
        on(event, callback) {
            if (!listeners.has(event)) {
                listeners.set(event, new Set());
            }
            listeners.get(event).add(callback);
        },

        off(event, callback) {
            const set = listeners.get(event);
            if (set) {
                set.delete(callback);
            }
        },
    };
}
