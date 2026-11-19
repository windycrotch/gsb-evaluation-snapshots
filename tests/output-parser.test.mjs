import { test } from "node:test";
import assert from "node:assert/strict";

import cbor from "cbor";
import {
    parseAuthenticatorData,
    parseAttestationObject,
    parseClientDataJSON,
    parseCredentials,
    toUserFacingMessage,
    CredentialParseError,
    CredentialParseErrorCode,
} from "../src/debugger/output-parser.js";

import {
    makeAuthData,
    makeRegistrationCredential,
    makeAuthenticationCredential,
    makeCoseKey,
    FLAGS,
} from "./helpers/cbor-samples.mjs";

test("parseAuthenticatorData: parses a well-formed registration authData", () => {
    const credentialId = Buffer.alloc(32, 0x22);
    const authData = makeAuthData({
        flags: FLAGS.USER_PRESENT | FLAGS.ATTESTED_CREDENTIAL_DATA,
        credentialId,
        coseKey: makeCoseKey(7),
    });

    const parsed = parseAuthenticatorData(authData);

    assert.equal(parsed.rpIdHash, Buffer.alloc(32, 0xaa).toString("hex"));
    assert.equal(parsed.flags.userPresent, true);
    assert.equal(parsed.flags.attestedCredentialData, true);
    assert.equal(parsed.signCount, 1);
    assert.deepEqual(parsed.attestedCredentialData.credentialId, credentialId);
    // The COSE key must round-trip through the decoder.
    const key = cbor.decodeFirstSync(
        parsed.attestedCredentialData.credentialPublicKey
    );
    assert.equal(key.get(3), -7);
});

test("parseAuthenticatorData: parses a minimal 37-byte assertion authData", () => {
    const authData = makeAuthData({ flags: FLAGS.USER_PRESENT });
    assert.equal(authData.length, 37);

    const parsed = parseAuthenticatorData(authData);
    assert.equal(parsed.flags.userPresent, true);
    assert.equal(parsed.signCount, 1);
});

test("parseAuthenticatorData: throws a recognizable error below 37 bytes", () => {
    const short = Buffer.alloc(36, 0x01);
    assert.throws(
        () => parseAuthenticatorData(short),
        (err) =>
            err instanceof CredentialParseError &&
            err.code ===
                CredentialParseErrorCode.AUTHENTICATOR_DATA_TOO_SHORT &&
            /37 bytes/.test(err.message)
    );
});

test("parseAuthenticatorData: trailing bytes produce a TRAILING_BYTES error", () => {
    const valid = makeAuthData({ flags: FLAGS.USER_PRESENT });
    const withTrailing = Buffer.concat([valid, Buffer.from([0xde, 0xad])]);

    assert.throws(
        () => parseAuthenticatorData(withTrailing),
        (err) =>
            err instanceof CredentialParseError &&
            err.code ===
                CredentialParseErrorCode.AUTHENTICATOR_DATA_TRAILING_BYTES &&
            /Leftover bytes/.test(err.message)
    );
});

test("parseAuthenticatorData: truncated attested credential data is a TRUNCATED error", () => {
    const authData = makeAuthData({
        flags: FLAGS.USER_PRESENT | FLAGS.ATTESTED_CREDENTIAL_DATA,
        credentialId: Buffer.alloc(32, 0x22),
        // Chop the buffer halfway through the COSE key.
        lengthOverride: 37 + 16 + 2 + 32 + 5,
    });

    assert.throws(
        () => parseAuthenticatorData(authData),
        (err) =>
            err instanceof CredentialParseError &&
            err.code ===
                CredentialParseErrorCode.AUTHENTICATOR_DATA_TRUNCATED
    );
});

test("parseAuthenticatorData: a credential ID longer than the buffer is TRUNCATED", () => {
    // 37 base + 16 aaguid + 2 length bytes, then declare a huge credential id
    const head = Buffer.concat([
        Buffer.alloc(32, 0xaa),
        Buffer.from([FLAGS.ATTESTED_CREDENTIAL_DATA]),
        Buffer.alloc(4, 0),
        Buffer.alloc(16, 0xbb),
        Buffer.from([0xff, 0xff]), // claims a 65535-byte credential id
    ]);

    assert.throws(
        () => parseAuthenticatorData(head),
        (err) =>
            err instanceof CredentialParseError &&
            err.code ===
                CredentialParseErrorCode.AUTHENTICATOR_DATA_TRUNCATED
    );
});

test("parseAuthenticatorData: accepts ArrayBuffer input", () => {
    const authData = makeAuthData({ flags: FLAGS.USER_PRESENT });
    const parsed = parseAuthenticatorData(
        authData.buffer.slice(
            authData.byteOffset,
            authData.byteOffset + authData.byteLength
        )
    );
    assert.equal(parsed.flags.userPresent, true);
});

test("parseAttestationObject: undecodable input throws ATTESTATION_OBJECT_INVALID", () => {
    const garbage = Buffer.from([0xff, 0xff, 0xff, 0xff]);
    assert.throws(
        () => parseAttestationObject(garbage),
        (err) =>
            err instanceof CredentialParseError &&
            err.code ===
                CredentialParseErrorCode.ATTESTATION_OBJECT_INVALID &&
            err.cause instanceof Error
    );
});

test("parseAttestationObject: bad nested authData keeps the specific parser code", () => {
    const attestation = new Map([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", Buffer.alloc(10, 0x01)], // too short
    ]);

    assert.throws(
        () => parseAttestationObject(cbor.encode(attestation)),
        (err) =>
            err instanceof CredentialParseError &&
            err.code ===
                CredentialParseErrorCode.AUTHENTICATOR_DATA_TOO_SHORT
    );
});

test("parseAttestationObject: parses a valid none attestation", () => {
    const credential = makeRegistrationCredential();
    const parsed = parseAttestationObject(
        credential.response.attestationObject
    );
    assert.equal(parsed.fmt, "none");
    assert.equal(parsed.authData.flags.userPresent, true);
});

test("parseClientDataJSON: invalid JSON throws CLIENT_DATA_JSON_INVALID", () => {
    assert.throws(
        () => parseClientDataJSON(Buffer.from("not-json{", "utf-8")),
        (err) =>
            err instanceof CredentialParseError &&
            err.code ===
                CredentialParseErrorCode.CLIENT_DATA_JSON_INVALID
    );
});

test("parseClientDataJSON: valid JSON is parsed", () => {
    const parsed = parseClientDataJSON(
        Buffer.from(JSON.stringify({ type: "webauthn.get" }), "utf-8")
    );
    assert.equal(parsed.type, "webauthn.get");
});

test("parseCredentials: full registration credential parses end to end", () => {
    const credential = makeRegistrationCredential();
    const parsed = parseCredentials(credential);

    assert.equal(parsed.response.clientDataJSON.type, "webauthn.create");
    assert.equal(
        parsed.response.attestationObject.authData.flags.userPresent,
        true
    );
    assert.ok(
        parsed.response.attestationObject.authData.attestedCredentialData
            .credentialPublicKey
    );
});

test("parseCredentials: full assertion credential parses end to end", () => {
    const credential = makeAuthenticationCredential();
    const parsed = parseCredentials(credential);

    assert.equal(parsed.response.clientDataJSON.type, "webauthn.get");
    assert.equal(parsed.response.authenticatorData.flags.userPresent, true);
    assert.deepEqual(parsed.response.signature, credential.response.signature);
});

test("parseCredentials: malformed authData surfaces the underlying parser error", () => {
    const credential = makeAuthenticationCredential({
        authData: makeAuthData({
            flags: FLAGS.USER_PRESENT,
            trailingBytes: Buffer.from([0x01]),
        }),
    });

    assert.throws(
        () => parseCredentials(credential),
        (err) =>
            err instanceof CredentialParseError &&
            err.code ===
                CredentialParseErrorCode.AUTHENTICATOR_DATA_TRAILING_BYTES
    );
});

test("parseCredentials: undecodable attestation object surfaces an identifiable error", () => {
    // Top-level CBOR that decodes fine but is not an attestation structure,
    // forcing parseAttestationObject down its invalid-object error path.
    const credential = makeRegistrationCredential({
        attestation: 42,
    });

    assert.throws(
        () => parseCredentials(credential),
        (err) =>
            err instanceof CredentialParseError &&
            err.code ===
                CredentialParseErrorCode.ATTESTATION_OBJECT_INVALID
    );
});

test("parseCredentials: non-CBOR attestation bytes surface an identifiable error", () => {
    const credential = makeRegistrationCredential();
    credential.response.attestationObject = Buffer.from([0xff, 0xff, 0xff]);

    assert.throws(
        () => parseCredentials(credential),
        (err) =>
            err instanceof CredentialParseError &&
            err.code ===
                CredentialParseErrorCode.ATTESTATION_OBJECT_INVALID
    );
});

test("toUserFacingMessage: maps every known code to readable guidance", () => {
    const codes = Object.values(CredentialParseErrorCode);
    for (const code of codes) {
        const message = toUserFacingMessage(
            new CredentialParseError(code, "detail")
        );
        assert.equal(typeof message, "string");
        assert.ok(message.length > 0);
        assert.notEqual(message, "detail");
    }
});

test("toUserFacingMessage: falls back to the raw message for unknown errors", () => {
    const message = toUserFacingMessage(new Error("boom"));
    assert.equal(message, "boom");
    assert.equal(toUserFacingMessage("plain string"), "plain string");
});
