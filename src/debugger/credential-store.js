import { deepClone } from "./utils.js";
import {
    parseCredentials,
    toUserFacingMessage,
    CredentialParseError,
    CredentialParseErrorCode,
} from "./output-parser.js";

/**
 * Entry points that can deliver credentials into the debugger.
 * Every entry shares the same "receive -> parse -> render" pipeline.
 */
export const CredentialSource = Object.freeze({
    REGISTRATION: "registration",
    AUTHENTICATION: "authentication",
    CBOR_IMPORT: "cbor-import",
});

/**
 * Single owner of the "most recent successfully parsed credential" state.
 *
 * Invariants:
 *  - `lastCredentials` / `lastCredentialsParsed` are only replaced after a
 *    successful parse. A failed receive (CBOR decode error, parser error,
 *    rejected navigator call) never overwrites the previous success.
 *  - Every async entry (register / authenticate / file import) gets a
 *    monotonic token. Stale tokens are rejected so only the result of the
 *    last initiated call can land.
 *  - allowCredentials rawIds are de-duplicated: the same rawId is never
 *    appended twice, and a rawId removed externally (e.g. the user deletes
 *    the row in the UI) can be added back on the next registration.
 *
 * This module intentionally has no DOM dependency so it can be exercised
 * directly from the offline test suite.
 */
export function createCredentialStore() {
    let lastCredentials = null;
    let lastCredentialsParsed = null;
    let lastError = null;
    let sequence = 0;

    // Per-source monotonic tokens; only the latest initiated call may land.
    const tokens = {
        [CredentialSource.REGISTRATION]: 0,
        [CredentialSource.AUTHENTICATION]: 0,
        [CredentialSource.CBOR_IMPORT]: 0,
    };

    // Bookkeeping of rawIds currently present in the login allowCredentials
    // list. Kept in sync from the DOM by the debugger layer.
    const allowedRawIds = new Set();

    function nextToken(source) {
        sequence += 1;
        tokens[source] = sequence;
        return sequence;
    }

    function isCurrent(source, token) {
        return tokens[source] === token;
    }

    function hasCredentials() {
        return lastCredentials !== null && lastCredentialsParsed !== null;
    }

    function getLastCredentials() {
        return lastCredentials ? deepClone(lastCredentials) : null;
    }

    function getLastCredentialsParsed() {
        return lastCredentialsParsed ? deepClone(lastCredentialsParsed) : null;
    }

    function getLastError() {
        return lastError;
    }

    /**
     * The single receive path used by registration, authentication and
     * CBOR import. Parsing happens before any state is mutated, so a failed
     * parse leaves the previous successful result untouched.
     *
     * @returns {{status: "ok", credentials: object, parsed: object, source: string, token: number}
     *         | {status: "stale", source: string, token: number}
     *         | {status: "error", error: Error, message: string, source: string, token: number}}
     */
    function acceptCredentials(source, credentials, token) {
        if (!isCurrent(source, token)) {
            return { status: "stale", source, token };
        }

        // A CBOR import may omit the browser-derived `id` field; reconstruct
        // it from rawId so imported credentials render identically to live
        // navigator.credentials results.
        if (
            credentials &&
            credentials.rawId &&
            (credentials.id === undefined || credentials.id === null)
        ) {
            credentials = {
                ...credentials,
                id: Buffer.from(credentials.rawId).toString("base64url"),
            };
        }

        let parsed;
        try {
            parsed = parseCredentials(credentials);
        } catch (error) {
            lastError = error;
            return {
                status: "error",
                error,
                message: toUserFacingMessage(error),
                source,
                token,
            };
        }

        // State mutation only happens after parsing succeeded.
        lastCredentials = deepClone(credentials);
        lastCredentialsParsed = parsed;
        lastError = null;

        return {
            status: "ok",
            credentials: deepClone(lastCredentials),
            parsed: deepClone(parsed),
            source,
            token,
        };
    }

    /**
     * Record a failure that happened before parsing (e.g. a rejected
     * navigator.credentials call or a CBOR file that cannot be decoded).
     * Stale tokens are ignored; stored credential state is never touched.
     */
    function reportFailure(source, error, token) {
        if (!isCurrent(source, token)) {
            return { status: "stale", source, token };
        }
        lastError = error;
        return {
            status: "error",
            error,
            message: toUserFacingMessage(error),
            source,
            token,
        };
    }

    /**
     * Clear the stored failure (e.g. after a later successful receive).
     */
    function clearError() {
        lastError = null;
    }

    // ---- allowCredentials de-duplication ---------------------------------

    /**
     * Replace the bookkeeping set with the rawIds currently present in the
     * UI. Rows removed by the user disappear from the set, so the same
     * rawId can be auto-filled again on a later registration.
     */
    function syncAllowedRawIds(rawIds) {
        allowedRawIds.clear();
        for (const rawId of rawIds) {
            if (rawId) {
                allowedRawIds.add(normalizeRawId(rawId));
            }
        }
    }

    function isAllowedRawIdPresent(rawId) {
        return allowedRawIds.has(normalizeRawId(rawId));
    }

    function addAllowedRawId(rawId) {
        allowedRawIds.add(normalizeRawId(rawId));
    }

    /**
     * Decide whether a freshly registered rawId should be appended to the
     * login allowCredentials list. Returns false when an entry with the
     * same rawId already exists; otherwise records it and returns true.
     */
    function shouldAddAllowedRawId(rawId) {
        const normalized = normalizeRawId(rawId);
        if (allowedRawIds.has(normalized)) {
            return false;
        }
        allowedRawIds.add(normalized);
        return true;
    }

    function getAllowedRawIds() {
        return Array.from(allowedRawIds);
    }

    return {
        CredentialSource,
        nextToken,
        isCurrent,
        acceptCredentials,
        reportFailure,
        clearError,
        hasCredentials,
        getLastCredentials,
        getLastCredentialsParsed,
        getLastError,
        syncAllowedRawIds,
        isAllowedRawIdPresent,
        addAllowedRawId,
        shouldAddAllowedRawId,
        getAllowedRawIds,
    };
}

function normalizeRawId(rawId) {
    if (rawId instanceof Buffer) {
        return rawId.toString("hex");
    }
    return String(rawId).toLowerCase();
}

export { CredentialParseError, CredentialParseErrorCode };
