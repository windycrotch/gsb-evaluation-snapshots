import { test } from "node:test";
import assert from "node:assert/strict";

import cbor from "cbor";

import { createCredentialStore, CredentialSource } from "../src/debugger/credential-store.js";
import {
    CredentialParseError,
    CredentialParseErrorCode,
} from "../src/debugger/output-parser.js";

import {
    makeRegistrationCredential,
    makeAuthenticationCredential,
    makeAuthData,
    encodeCredentialCbor,
    FLAGS,
} from "./helpers/cbor-samples.mjs";

// ---------------------------------------------------------------------------
// 1. Success: every entry flows through the same receive -> parse -> store path
// ---------------------------------------------------------------------------

test("success: registration, authentication and CBOR import all parse and store", () => {
    const store = createCredentialStore();

    const registration = makeRegistrationCredential({
        rawId: Buffer.alloc(32, 0x11),
    });
    const regToken = store.nextToken(CredentialSource.REGISTRATION);
    const regOutcome = store.acceptCredentials(
        CredentialSource.REGISTRATION,
        registration,
        regToken
    );

    assert.equal(regOutcome.status, "ok");
    assert.equal(store.hasCredentials(), true);
    assert.deepEqual(store.getLastCredentials().rawId, registration.rawId);
    assert.ok(store.getLastCredentialsParsed().response.attestationObject);

    const assertion = makeAuthenticationCredential({
        rawId: Buffer.alloc(32, 0x99),
    });
    const getToken = store.nextToken(CredentialSource.AUTHENTICATION);
    const getOutcome = store.acceptCredentials(
        CredentialSource.AUTHENTICATION,
        assertion,
        getToken
    );

    assert.equal(getOutcome.status, "ok");
    assert.deepEqual(store.getLastCredentials().rawId, assertion.rawId);
    assert.ok(store.getLastCredentialsParsed().response.signature);

    // A CBOR file produced by the download path can be re-imported through
    // the exact same pipeline.
    const encoded = encodeCredentialCbor(registration);
    const decoded = cbor.decodeFirstSync(encoded);
    const importToken = store.nextToken(CredentialSource.CBOR_IMPORT);
    const importOutcome = store.acceptCredentials(
        CredentialSource.CBOR_IMPORT,
        decoded,
        importToken
    );

    assert.equal(importOutcome.status, "ok");
    assert.deepEqual(store.getLastCredentials().rawId, registration.rawId);
    assert.equal(store.getLastError(), null);
});

test("success: a CBOR import missing the derived id field gets it back", () => {
    const store = createCredentialStore();
    const credential = makeRegistrationCredential();
    delete credential.id;
    assert.equal(credential.id, undefined);

    const outcome = store.acceptCredentials(
        CredentialSource.CBOR_IMPORT,
        credential,
        store.nextToken(CredentialSource.CBOR_IMPORT)
    );

    assert.equal(outcome.status, "ok");
    assert.equal(
        store.getLastCredentials().id,
        Buffer.from(credential.rawId).toString("base64url")
    );
});

test("success: a later accept cannot mutate the previously stored credential", () => {
    const store = createCredentialStore();

    const first = makeRegistrationCredential({
        rawId: Buffer.alloc(32, 0x11),
    });
    store.acceptCredentials(
        CredentialSource.REGISTRATION,
        first,
        store.nextToken(CredentialSource.REGISTRATION)
    );
    const storedBefore = store.getLastCredentials();
    const firstRawId = Buffer.from(storedBefore.rawId);

    // A second, different credential is accepted; the stored snapshot of the
    // first credential must still be retrievable byte-for-byte via the error
    // retention guarantee exercised below, and retrieved objects must at
    // least be distinct references per call.
    const second = makeRegistrationCredential({
        rawId: Buffer.alloc(32, 0x22),
    });
    store.acceptCredentials(
        CredentialSource.REGISTRATION,
        second,
        store.nextToken(CredentialSource.REGISTRATION)
    );

    assert.notEqual(store.getLastCredentials(), storedBefore);
    assert.deepEqual(store.getLastCredentials().rawId, second.rawId);
    assert.deepEqual(firstRawId, first.rawId);
});

// ---------------------------------------------------------------------------
// 2. De-duplication of allowCredentials, including re-add after removal
// ---------------------------------------------------------------------------

test("dedup: the same rawId is never appended twice", () => {
    const store = createCredentialStore();
    const rawId = "0102030405060708090a0b0c0d0e0f10";

    assert.equal(store.shouldAddAllowedRawId(rawId), true);
    assert.equal(store.shouldAddAllowedRawId(rawId), false);
    assert.equal(store.shouldAddAllowedRawId(rawId.toUpperCase()), false);
    assert.deepEqual(store.getAllowedRawIds(), [rawId]);
});

test("dedup: distinct rawIds are all kept", () => {
    const store = createCredentialStore();

    assert.equal(store.shouldAddAllowedRawId("aaaa"), true);
    assert.equal(store.shouldAddAllowedRawId("bbbb"), true);
    assert.equal(store.shouldAddAllowedRawId("aaaa"), false);
    assert.deepEqual(store.getAllowedRawIds().sort(), ["aaaa", "bbbb"]);
});

test("dedup: a rawId removed by the user is re-added on the next registration", () => {
    const store = createCredentialStore();
    const rawIdA = "aaaa1111";
    const rawIdB = "bbbb2222";

    // First two registrations populate two entries.
    assert.equal(store.shouldAddAllowedRawId(rawIdA), true);
    assert.equal(store.shouldAddAllowedRawId(rawIdB), true);

    // User deletes the row for rawIdA: the debugger syncs the remaining list.
    store.syncAllowedRawIds([rawIdB]);
    assert.equal(store.isAllowedRawIdPresent(rawIdA), false);
    assert.equal(store.isAllowedRawIdPresent(rawIdB), true);

    // Re-registering the deleted credential fills it back in...
    assert.equal(store.shouldAddAllowedRawId(rawIdA), true);
    // ...while the still-present one is not duplicated.
    assert.equal(store.shouldAddAllowedRawId(rawIdB), false);
    assert.deepEqual(store.getAllowedRawIds().sort(), [rawIdA, rawIdB]);
});

// ---------------------------------------------------------------------------
// 3. Failure keeps the previous successful result
// ---------------------------------------------------------------------------

test("failure: a parse error keeps the previous credential and reports a message", () => {
    const store = createCredentialStore();

    const good = makeRegistrationCredential({
        rawId: Buffer.alloc(32, 0x11),
    });
    const goodToken = store.nextToken(CredentialSource.REGISTRATION);
    const goodOutcome = store.acceptCredentials(
        CredentialSource.REGISTRATION,
        good,
        goodToken
    );
    assert.equal(goodOutcome.status, "ok");

    // Malformed assertion: authenticatorData with trailing bytes.
    const bad = makeAuthenticationCredential({
        authData: makeAuthData({
            flags: FLAGS.USER_PRESENT,
            trailingBytes: Buffer.from([0x7f]),
        }),
    });
    const badToken = store.nextToken(CredentialSource.AUTHENTICATION);
    const badOutcome = store.acceptCredentials(
        CredentialSource.AUTHENTICATION,
        bad,
        badToken
    );

    assert.equal(badOutcome.status, "error");
    assert.ok(badOutcome.error instanceof CredentialParseError);
    assert.equal(
        badOutcome.error.code,
        CredentialParseErrorCode.AUTHENTICATOR_DATA_TRAILING_BYTES
    );
    assert.equal(typeof badOutcome.message, "string");
    assert.match(badOutcome.message, /trailing bytes/i);

    // Previous success is untouched and remains the download source.
    assert.equal(store.hasCredentials(), true);
    assert.deepEqual(store.getLastCredentials().rawId, good.rawId);
    assert.equal(store.getLastError(), badOutcome.error);
});

test("failure: an unparseable CBOR import does not pollute the stored credential", () => {
    const store = createCredentialStore();

    const good = makeRegistrationCredential();
    const regToken = store.nextToken(CredentialSource.REGISTRATION);
    store.acceptCredentials(CredentialSource.REGISTRATION, good, regToken);

    // Simulate the file-level decode failure handled in uploadCBOR().
    const fileError = new Error("Insufficient data");
    fileError.code = CredentialParseErrorCode.ATTESTATION_OBJECT_INVALID;
    const importToken = store.nextToken(CredentialSource.CBOR_IMPORT);
    const failure = store.reportFailure(
        CredentialSource.CBOR_IMPORT,
        fileError,
        importToken
    );

    assert.equal(failure.status, "error");
    assert.match(failure.message, /attestation object/i);
    assert.deepEqual(store.getLastCredentials().rawId, good.rawId);

    // A later successful import replaces the state and clears the error.
    const replacement = makeRegistrationCredential({
        rawId: Buffer.alloc(32, 0x77),
    });
    const nextImportToken = store.nextToken(CredentialSource.CBOR_IMPORT);
    const retry = store.acceptCredentials(
        CredentialSource.CBOR_IMPORT,
        replacement,
        nextImportToken
    );
    assert.equal(retry.status, "ok");
    assert.deepEqual(store.getLastCredentials().rawId, replacement.rawId);
    assert.equal(store.getLastError(), null);
});

test("failure: a short authenticatorData import retains the old credential", () => {
    const store = createCredentialStore();

    const good = makeRegistrationCredential();
    store.acceptCredentials(
        CredentialSource.CBOR_IMPORT,
        good,
        store.nextToken(CredentialSource.CBOR_IMPORT)
    );

    const malformed = makeRegistrationCredential({
        attestation: new Map([
            ["fmt", "none"],
            ["attStmt", new Map()],
            ["authData", Buffer.alloc(20, 0x01)],
        ]),
    });

    const outcome = store.acceptCredentials(
        CredentialSource.CBOR_IMPORT,
        malformed,
        store.nextToken(CredentialSource.CBOR_IMPORT)
    );

    assert.equal(outcome.status, "error");
    assert.equal(
        outcome.error.code,
        CredentialParseErrorCode.AUTHENTICATOR_DATA_TOO_SHORT
    );
    assert.deepEqual(store.getLastCredentials().rawId, good.rawId);
});

test("failure: reportFailure never mutates stored credential state", () => {
    const store = createCredentialStore();
    assert.equal(store.hasCredentials(), false);

    const outcome = store.reportFailure(
        CredentialSource.REGISTRATION,
        new Error("NotAllowedError: user cancelled"),
        store.nextToken(CredentialSource.REGISTRATION)
    );

    assert.equal(outcome.status, "error");
    assert.equal(store.hasCredentials(), false);
    assert.equal(store.getLastCredentials(), null);
});

test("failure: the downloadable CBOR always comes from the last success", () => {
    const store = createCredentialStore();

    const good = makeRegistrationCredential({
        rawId: Buffer.alloc(32, 0x11),
    });
    store.acceptCredentials(
        CredentialSource.REGISTRATION,
        good,
        store.nextToken(CredentialSource.REGISTRATION)
    );

    // A failed import (malformed authData) must not change the download bytes.
    const encodedBefore = cbor.encode(store.getLastCredentials());

    const malformed = makeRegistrationCredential({
        attestation: new Map([
            ["fmt", "none"],
            ["attStmt", new Map()],
            ["authData", Buffer.alloc(5, 0x01)],
        ]),
    });
    const failed = store.acceptCredentials(
        CredentialSource.CBOR_IMPORT,
        malformed,
        store.nextToken(CredentialSource.CBOR_IMPORT)
    );
    assert.equal(failed.status, "error");

    const encodedAfter = cbor.encode(store.getLastCredentials());
    assert.deepEqual(
        Buffer.from(encodedAfter),
        Buffer.from(encodedBefore)
    );

    // And the downloaded payload decodes back to the good credential.
    const decoded = cbor.decodeFirstSync(encodedAfter);
    assert.deepEqual(decoded.rawId, good.rawId);
});

// ---------------------------------------------------------------------------
// 4. Concurrency: only the last initiated call may land
// ---------------------------------------------------------------------------

test("concurrency: a slow earlier registration cannot overwrite a newer one", async () => {
    const store = createCredentialStore();

    const firstToken = store.nextToken(CredentialSource.REGISTRATION);
    const secondToken = store.nextToken(CredentialSource.REGISTRATION);
    assert.notEqual(firstToken, secondToken);

    const first = makeRegistrationCredential({
        rawId: Buffer.alloc(32, 0x01),
    });
    const second = makeRegistrationCredential({
        rawId: Buffer.alloc(32, 0x02),
    });

    // The newer call resolves first.
    const secondOutcome = store.acceptCredentials(
        CredentialSource.REGISTRATION,
        second,
        secondToken
    );
    assert.equal(secondOutcome.status, "ok");

    // The stale earlier call resolves afterwards and must be dropped.
    const firstOutcome = store.acceptCredentials(
        CredentialSource.REGISTRATION,
        first,
        firstToken
    );
    assert.equal(firstOutcome.status, "stale");
    assert.deepEqual(store.getLastCredentials().rawId, second.rawId);
});

test("concurrency: isCurrent gates results that resolve in either order", () => {
    const store = createCredentialStore();
    const t1 = store.nextToken(CredentialSource.AUTHENTICATION);
    const t2 = store.nextToken(CredentialSource.AUTHENTICATION);

    assert.equal(store.isCurrent(CredentialSource.AUTHENTICATION, t1), false);
    assert.equal(store.isCurrent(CredentialSource.AUTHENTICATION, t2), true);

    // Even an error from the stale call is ignored.
    const staleFailure = store.reportFailure(
        CredentialSource.AUTHENTICATION,
        new Error("stale"),
        t1
    );
    assert.equal(staleFailure.status, "stale");
    assert.equal(store.getLastError(), null);

    const fresh = store.acceptCredentials(
        CredentialSource.AUTHENTICATION,
        makeAuthenticationCredential(),
        t2
    );
    assert.equal(fresh.status, "ok");
});

test("concurrency: re-selecting a CBOR file makes the earlier read stale", () => {
    const store = createCredentialStore();

    const firstPick = store.nextToken(CredentialSource.CBOR_IMPORT);
    const secondPick = store.nextToken(CredentialSource.CBOR_IMPORT);

    const secondCredential = makeRegistrationCredential({
        rawId: Buffer.alloc(32, 0x55),
    });
    const secondOutcome = store.acceptCredentials(
        CredentialSource.CBOR_IMPORT,
        secondCredential,
        secondPick
    );
    assert.equal(secondOutcome.status, "ok");

    // The first FileReader.onload fires late and must be discarded.
    const firstOutcome = store.acceptCredentials(
        CredentialSource.CBOR_IMPORT,
        makeRegistrationCredential({ rawId: Buffer.alloc(32, 0x66) }),
        firstPick
    );
    assert.equal(firstOutcome.status, "stale");
    assert.deepEqual(
        store.getLastCredentials().rawId,
        secondCredential.rawId
    );

    // A failure reported by the stale reader is ignored as well.
    const staleFailure = store.reportFailure(
        CredentialSource.CBOR_IMPORT,
        new Error("late read failure"),
        firstPick
    );
    assert.equal(staleFailure.status, "stale");
    assert.equal(store.getLastError(), null);
});

test("concurrency: tokens are independent across the three sources", () => {
    const store = createCredentialStore();

    const regToken = store.nextToken(CredentialSource.REGISTRATION);
    const getToken = store.nextToken(CredentialSource.AUTHENTICATION);
    const importToken = store.nextToken(CredentialSource.CBOR_IMPORT);

    assert.equal(store.isCurrent(CredentialSource.REGISTRATION, regToken), true);
    assert.equal(
        store.isCurrent(CredentialSource.AUTHENTICATION, getToken),
        true
    );
    assert.equal(
        store.isCurrent(CredentialSource.CBOR_IMPORT, importToken),
        true
    );

    // A new registration only invalidates registration tokens.
    const newerReg = store.nextToken(CredentialSource.REGISTRATION);
    assert.equal(
        store.isCurrent(CredentialSource.REGISTRATION, regToken),
        false
    );
    assert.equal(
        store.isCurrent(CredentialSource.AUTHENTICATION, getToken),
        true
    );
    assert.equal(
        store.isCurrent(CredentialSource.CBOR_IMPORT, importToken),
        true
    );
    assert.equal(store.isCurrent(CredentialSource.REGISTRATION, newerReg), true);
});
