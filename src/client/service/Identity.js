/**
 * Holds the stable identity token used to prove who a client is
 * across short network disconnections.
 *
 * The token is generated once and persisted in the browser storage,
 * then sent on every socket connection so the server can reuse the
 * matching user entry instead of creating a new one.
 */
export default class Identity {
    static KEY = 'identity:token';

    constructor(storage) {
        this.storage = storage;
        this.token = null;
    }

    /**
     * Get the current token, generating and persisting it on first use.
     *
     * @return {String}
     */
    getToken() {
        if (!this.token) {
            this.token = this.load() || this.generate();
        }

        return this.token;
    }

    load() {
        const token = this.storage.get(this.constructor.KEY);

        return typeof token === 'string' && token ? token : null;
    }

    generate() {
        const token = globalThis.crypto.randomUUID
            ? globalThis.crypto.randomUUID()
            : this.fallback();

        this.storage.set(this.constructor.KEY, token);

        return token;
    }

    fallback() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
            const random = Math.floor(Math.random() * 16);
            const value = character === 'x' ? random : (random & 0x3 | 0x8);

            return value.toString(16);
        });
    }
}
