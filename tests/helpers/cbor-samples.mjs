// Hand-built WebAuthn CBOR samples for the offline tests. Everything is
// generated from Buffers/Maps and the project's own `cbor` dependency, so no
// network or browser APIs are required.
import cbor from "cbor";

export const FLAGS = Object.freeze({
    NONE: 0x00,
    USER_PRESENT: 0x01,
    USER_VERIFIED: 0x04,
    ATTESTED_CREDENTIAL_DATA: 0x40,
    EXTENSION_DATA: 0x80,
});

function u32be(value) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(value >>> 0, 0);
    return buf;
}

function u16be(value) {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(value, 0);
    return buf;
}

/**
 * Build a minimal valid ES256 COSE public key (EC2, P-256).
 */
export function makeCoseKey(seed = 1) {
    return new Map([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.alloc(32, seed)], // x
        [-3, Buffer.alloc(32, seed + 100)], // y
    ]);
}

/**
 * Build an authenticatorData buffer.
 *
 * @param {object} [opts]
 * @param {number} [opts.flags]            flag byte
 * @param {Buffer} [opts.credentialId]     when present, AT flag is implied
 * @param {Map}    [opts.coseKey]          COSE key following the credential id
 * @param {object} [opts.extensions]       extension object (ED flag implied)
 * @param {Buffer} [opts.trailingBytes]    extra bytes appended at the end
 * @param {number} [opts.lengthOverride]   truncate/extend the final buffer
 * @param {Buffer} [opts.rpIdHash]
 */
export function makeAuthData(opts = {}) {
    const flags =
        opts.flags !== undefined ?
        opts.flags :
        FLAGS.USER_PRESENT |
            (opts.credentialId ? FLAGS.ATTESTED_CREDENTIAL_DATA : 0) |
            (opts.extensions ? FLAGS.EXTENSION_DATA : 0);

    const parts = [
        opts.rpIdHash || Buffer.alloc(32, 0xaa),
        Buffer.from([flags]),
        u32be(opts.signCount ?? 1),
    ];

    if (opts.credentialId) {
        parts.push(Buffer.alloc(16, 0xbb)); // aaguid
        parts.push(u16be(opts.credentialId.length));
        parts.push(opts.credentialId);
        parts.push(cbor.encode(opts.coseKey || makeCoseKey()));
    }

    if (opts.extensions) {
        parts.push(cbor.encode(opts.extensions));
    }

    if (opts.trailingBytes) {
        parts.push(opts.trailingBytes);
    }

    let authData = Buffer.concat(parts);

    if (typeof opts.lengthOverride === "number") {
        if (opts.lengthOverride <= authData.length) {
            authData = authData.slice(0, opts.lengthOverride);
        } else {
            authData = Buffer.concat([
                authData,
                Buffer.alloc(opts.lengthOverride - authData.length, 0xcc),
            ]);
        }
    }

    return authData;
}

/**
 * Full PublicKeyCredential-shaped object as returned by
 * navigator.credentials.create(), with an attestationObject containing the
 * given authenticator data.
 */
export function makeRegistrationCredential(options = {}) {
    const rawId = options.rawId || Buffer.alloc(32, 0x11);
    const authData = options.authData || makeAuthData({
        flags: FLAGS.USER_PRESENT | FLAGS.ATTESTED_CREDENTIAL_DATA,
        credentialId: options.credentialId || Buffer.alloc(32, 0x22),
        coseKey: options.coseKey,
    });

    const attestationObject = cbor.encode(
        options.attestation || new Map([
            ["fmt", "none"],
            ["attStmt", new Map()],
            ["authData", authData],
        ])
    );

    const clientDataJSON = Buffer.from(
        JSON.stringify(
            options.clientData || {
                type: "webauthn.create",
                challenge: "MOCK-CREATE-CHALLENGE",
                origin: "https://example.test",
            }
        ),
        "utf-8"
    );

    const credential = {
        id: rawId.toString("base64url"),
        rawId,
        type: "public-key",
        response: {
            attestationObject,
            clientDataJSON,
        },
    };

    if (options.includeBrowserMethods) {
        credential.getClientExtensionResults = () => ({ credProps: {} });
        credential.response.getTransports = () => ["usb"];
    }

    return credential;
}

/**
 * PublicKeyCredential-shaped object as returned by navigator.credentials.get().
 */
export function makeAuthenticationCredential(options = {}) {
    const rawId = options.rawId || Buffer.alloc(32, 0x33);
    const authData = options.authData || makeAuthData({
        flags: FLAGS.USER_PRESENT,
    });

    const clientDataJSON = Buffer.from(
        JSON.stringify(
            options.clientData || {
                type: "webauthn.get",
                challenge: "MOCK-GET-CHALLENGE",
                origin: "https://example.test",
            }
        ),
        "utf-8"
    );

    return {
        id: rawId.toString("base64url"),
        rawId,
        type: "public-key",
        response: {
            authenticatorData: authData,
            clientDataJSON,
            signature: options.signature || Buffer.alloc(64, 0x44),
            userHandle: options.userHandle || Buffer.alloc(16, 0x55),
        },
    };
}

/**
 * Encode an arbitrary credential object as a standalone CBOR file, matching
 * what the Upload CBOR entry point decodes.
 */
export function encodeCredentialCbor(credential) {
    return cbor.encode(credential);
}
