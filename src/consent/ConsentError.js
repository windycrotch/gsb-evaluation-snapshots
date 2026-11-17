/**
 * Error used when a third-party resource is not loaded because consent was denied.
 * Distinct from `AbortError` so pending load tasks can be rejected instead of left hanging.
 * @exports  module:src/consent/ConsentError
 * @augments Error
 * @author   Frank Kudermann - alphanull
 * @version  1.0.0
 * @license  MIT
 */
export default class ConsentError extends Error {

    /**
     * Creates a ConsentError.
     * @param {string} [message]  Human-readable error message.
     */
    constructor(message) {

        super(message);
        this.name = 'ConsentError';

    }

}
