import { deepClone, objectSlice, transform, prettyStringify, decodeCborFirst } from "./utils.js";

import { prettifyTransformations } from "./transformations.js";

import cbor from "cbor";
import log from "loglevel";

/**
 * Stable, recognizable error codes thrown while parsing credential data.
 * The debugger layer maps these to user-readable messages via
 * {@link toUserFacingMessage}.
 */
export const CredentialParseErrorCode = Object.freeze({
    AUTHENTICATOR_DATA_TOO_SHORT: "AUTHENTICATOR_DATA_TOO_SHORT",
    AUTHENTICATOR_DATA_TRUNCATED: "AUTHENTICATOR_DATA_TRUNCATED",
    AUTHENTICATOR_DATA_TRAILING_BYTES: "AUTHENTICATOR_DATA_TRAILING_BYTES",
    ATTESTATION_OBJECT_INVALID: "ATTESTATION_OBJECT_INVALID",
    CLIENT_DATA_JSON_INVALID: "CLIENT_DATA_JSON_INVALID",
    CREDENTIAL_MALFORMED: "CREDENTIAL_MALFORMED",
});

/**
 * Error type that always carries a machine-readable `code` so callers can
 * distinguish parsing failures (bad input data) from runtime failures
 * (e.g. the user cancelling the navigator.credentials prompt).
 */
export class CredentialParseError extends Error {
    constructor(code, message, cause) {
        super(message);
        this.name = "CredentialParseError";
        this.code = code;
        if (typeof cause !== "undefined") {
            this.cause = cause;
        }
    }
}

/**
 * Map any thrown value to a human-readable message. Recognized
 * {@link CredentialParseError} instances get specific guidance, every other
 * failure gets a generic message that still includes the underlying detail.
 */
export function toUserFacingMessage(error) {
    const detail = error && error.message ? error.message : String(error);

    switch (error && error.code) {
        case CredentialParseErrorCode.AUTHENTICATOR_DATA_TOO_SHORT:
            return `Invalid authenticator data: it is shorter than the required 37 bytes. ${detail}`;
        case CredentialParseErrorCode.AUTHENTICATOR_DATA_TRUNCATED:
            return `Invalid authenticator data: it is truncated and ends before all advertised fields were parsed. ${detail}`;
        case CredentialParseErrorCode.AUTHENTICATOR_DATA_TRAILING_BYTES:
            return `Invalid authenticator data: unexpected trailing bytes were found after the declared fields. ${detail}`;
        case CredentialParseErrorCode.ATTESTATION_OBJECT_INVALID:
            return `Invalid attestation object: it could not be decoded as CBOR (unknown attestation type?). ${detail}`;
        case CredentialParseErrorCode.CLIENT_DATA_JSON_INVALID:
            return `Invalid clientDataJSON: the payload is not valid JSON. ${detail}`;
        case CredentialParseErrorCode.CREDENTIAL_MALFORMED:
            return `The credential data is malformed and could not be parsed. ${detail}`;
        default:
            return detail;
    }
}

export function parseAuthenticatorData(authData) {
    authData =
        authData instanceof ArrayBuffer ?
        Buffer.from(authData) :
        authData;


    if (authData.byteLength < 37) {
        throw new CredentialParseError(
            CredentialParseErrorCode.AUTHENTICATOR_DATA_TOO_SHORT,
            `Authenticator data was ${authData.byteLength} bytes, expected at least 37 bytes`,
        );
    }

    const result = {};
    let pointer = 0;

    result.rpIdHash = authData.slice(pointer, (pointer += 32)).toString('hex');

    const flagsBuf = authData.slice(pointer, (pointer += 1));
    const flagsInt = flagsBuf[0];

    // Bit positions can be referenced here:
    // https://w3c.github.io/webauthn/#flags
    result.flags = {
        userPresent: (flagsInt & 0x01) !== 0,
        reserved1: (flagsInt & 0x02) !== 0,
        userVerified: (flagsInt & 0x04) !== 0,
        backupEligibility: (flagsInt & 0x08) !== 0,
        backupState: (flagsInt & 0x10) !== 0,
        reserved2: (flagsInt & 0x20) !== 0,
        attestedCredentialData: (flagsInt & 0x40) !== 0,
        extensionDataIncluded: (flagsInt & 0x80) !== 0,
    };

    const counterBuf = authData.slice(pointer, (pointer += 4));
    result.signCount = counterBuf.readUInt32BE(0);

    if (result.flags.attestedCredentialData) {
        const atCredData = {};
        result.attestedCredentialData = atCredData;

        atCredData.aaguid = authData.slice(pointer, (pointer += 16));

        if (pointer + 2 > authData.byteLength) {
            throw new CredentialParseError(
                CredentialParseErrorCode.AUTHENTICATOR_DATA_TRUNCATED,
                "Authenticator data is truncated before the credential ID length",
            );
        }

        const credIdLenBuf = authData.slice(pointer, (pointer += 2));
        const credIdLen = credIdLenBuf.readUInt16BE(0);

        if (pointer + credIdLen > authData.byteLength) {
            throw new CredentialParseError(
                CredentialParseErrorCode.AUTHENTICATOR_DATA_TRUNCATED,
                `Authenticator data declares a ${credIdLen}-byte credential ID but only ${authData.byteLength - pointer} bytes remain`,
            );
        }

        atCredData.credentialId = authData.slice(pointer, (pointer += credIdLen));

        // Decode the next CBOR item in the buffer, then re-encode it back to a Buffer
        let firstDecoded;
        let firstEncoded;
        try {
            firstDecoded = decodeCborFirst(authData.slice(pointer));
            firstEncoded = Buffer.from(cbor.encode(firstDecoded));
        } catch (e) {
            throw new CredentialParseError(
                CredentialParseErrorCode.AUTHENTICATOR_DATA_TRUNCATED,
                "Authenticator data is truncated before a valid credential public key (COSE) was found",
                e,
            );
        }
        atCredData.credentialPublicKey = firstEncoded;
        pointer += firstEncoded.byteLength;
    }

    if (result.flags.extensionDataIncluded) {
        let firstDecoded;
        let firstEncoded;
        try {
            firstDecoded = decodeCborFirst(authData.slice(pointer));
            firstEncoded = Buffer.from(cbor.encode(firstDecoded));
        } catch (e) {
            throw new CredentialParseError(
                CredentialParseErrorCode.AUTHENTICATOR_DATA_TRUNCATED,
                "Authenticator data is truncated before the extension data was fully parsed",
                e,
            );
        }
        const extensionsDataBuffer = firstEncoded;
        result.attestedExtensionData = cbor.decodeFirstSync(extensionsDataBuffer);
        pointer += firstEncoded.byteLength;
    }

    // Pointer should be at the end of the authenticator data, otherwise too much data was sent
    if (authData.byteLength > pointer) {
        throw new CredentialParseError(
            CredentialParseErrorCode.AUTHENTICATOR_DATA_TRAILING_BYTES,
            `Leftover bytes detected while parsing authenticator data (${authData.byteLength - pointer} byte(s) remaining)`,
        );
    }

    return result;
}

export function parseAttestationObject(data) {
    const buffer =
        data instanceof ArrayBuffer ?
        Buffer.from(data) :
        Buffer.from(data.buffer, data.byteOffset, data.byteLength);

    let decoded;
    try {
        decoded = cbor.decodeFirstSync(buffer);
    } catch (e) {
        // Always throw a recognizable error instead of returning a string:
        // callers rely on the structured result and would crash otherwise.
        throw new CredentialParseError(
            CredentialParseErrorCode.ATTESTATION_OBJECT_INVALID,
            "Failed to decode attestationObject, unknown attestation type?",
            e,
        );
    }

    if (!decoded || typeof decoded !== "object") {
        throw new CredentialParseError(
            CredentialParseErrorCode.ATTESTATION_OBJECT_INVALID,
            "Decoded attestationObject did not contain a structured object",
        );
    }

    if (decoded.authData) {
        // parseAuthenticatorData throws CredentialParseError on bad input,
        // let that propagate with its specific code.
        decoded.authData = parseAuthenticatorData(decoded.authData);
    }

    return decoded;
}

export function parseClientDataJSON(data) {
    const decoder = new TextDecoder("utf-8");
    const decoded = decoder.decode(data);
    try {
        return JSON.parse(decoded);
    } catch (e) {
        throw new CredentialParseError(
            CredentialParseErrorCode.CLIENT_DATA_JSON_INVALID,
            "clientDataJSON could not be parsed as JSON",
            e,
        );
    }
}

export function parseCredentials(credentials) {
    const result = deepClone(credentials);
    const transformations = objectSlice(prettifyTransformations, [
        "clientDataJSON",
        "authenticatorData",
        "attestationObject",
    ]);

    try {
        transform(result, transformations);
    } catch (e) {
        if (e instanceof CredentialParseError) {
            throw e;
        }
        throw new CredentialParseError(
            CredentialParseErrorCode.CREDENTIAL_MALFORMED,
            "Credential could not be parsed",
            e,
        );
    }
    return result;
}

export function prettifyCredentials(credentials) {
    const creds = deepClone(credentials);
    transform(creds, prettifyTransformations);
    return splitCredentialsByType(creds);
}

export function addMarkupToLine(line) {
    const separator = line.indexOf(":");
    const head = line.substring(0, separator);
    const tail = line.substr(separator);

    if (separator < 0) {
        return line;
    }

    if (tail === ": {") {
        return `<span class="output-key">${head}</span>${tail}`;
    }

    return `<span class="output-key">${head}</span><span class="output-value">${tail}</span>`;
}

export function splitCredentialsByType(credentials) {
    let cred = `<code class="output-section"><pre>rawId: ${credentials.rawId}\nid: ${credentials.id}\ntype: ${credentials.type}\n</pre></code>\n<div class="output-section output-section-transparent">response: {</div>`;

    if (credentials.clientDataJSON && credentials.signature) {
        cred += `\n\n<code class="output-section output-section-turqoise"><pre>signature: ${
      credentials.signature
    }\n</pre>
      <pre>userHandle: ${credentials.userHandle}\n</pre>
      <pre>clientDataJSON: ${prettyStringify(
        credentials.clientDataJSON
      )}</pre></code>`;
    } else if (credentials.clientDataJSON) {
        cred += `<code class="output-section output-section-turqoise"><pre>clientDataJSON: ${prettyStringify(
      credentials.clientDataJSON
    )}</pre></code>`;
    }

    if (credentials.authenticatorAttachment || credentials.transports) {
        cred += `<code class="output-section output-section-green"><pre>`
        if (credentials.authenticatorAttachment) {
            cred += `authenticatorAttachment: ${credentials.authenticatorAttachment},\n`;
        }
        if (credentials.transports) {
            // registration only
            cred += `transports: ${prettyStringify(credentials.transports)},`;
        }
        cred += `</pre></code>`;
    }

    if (credentials.attestationObject) {
        cred += `<code class="output-section output-section-green"><pre>attestationObject: ${prettyStringify(
      credentials.attestationObject
    )},</pre></code>`;
    }

    if (credentials.authenticatorData) {
        cred += `<code class="output-section output-section-green"><pre>authenticatorData: ${prettyStringify(
      credentials.authenticatorData
    )},</pre></code>`;
    }

    if (credentials.extensions) {
        cred += `<code class="output-section output-section-green">
        <pre>extensions: ${prettyStringify(
        credentials.extensions
        )}</pre></code>`;
    }

    cred += `<div class="output-section output-section-transparent">}</div>`;

    return cred;
}

export function orderCredentialsByType(credentials) {
    const orderedCredentials = {
        rawId: credentials.rawId,
        id: credentials.id,
        type: credentials.type,
        clientDataJSON: credentials.response.clientDataJSON,
    };

    if (credentials.authenticatorAttachment) {
        orderedCredentials.authenticatorAttachment =
            credentials.authenticatorAttachment;
    }

    if (credentials.response.attestationObject) {
        orderedCredentials.attestationObject =
            credentials.response.attestationObject;
    }

    if (credentials.response.authenticatorData) {
        orderedCredentials.authenticatorData =
            credentials.response.authenticatorData;
    }

    if (credentials.response.signature) {
        orderedCredentials.signature = credentials.response.signature;
    }

    if (credentials.response.userHandle) {
        orderedCredentials.userHandle = credentials.response.userHandle;
    }

    if (typeof credentials.response.getTransports === 'function') {
        orderedCredentials.transports = credentials.response.getTransports();
    }

    if (typeof credentials.getClientExtensionResults === 'function') {
        orderedCredentials.extensions = credentials.getClientExtensionResults();
    }

    return orderedCredentials;
}

export function prettyCredentialsWithHtml(prettyCredentials) {
    let lines = prettyCredentials.split("\n");

    lines = lines.map((line) => {
        for (const key of Object.keys(prettifyTransformations)) {
            const keyStr = `"${key}": `;
            const idx = line.indexOf(keyStr);
            if (idx !== -1 && prettifyTransformations[key].buttons) {
                const pos = idx + keyStr.length;

                const head = line.substring(0, pos);
                const tail = line.substring(pos);

                let buttons = "";
                for (const but of prettifyTransformations[key].buttons) {
                    buttons +=
                        `<button class="button hide-mobile" data-key="${key}" onclick="outputButtonClick(event);">` +
                        `${but}</button>`;
                }
                line = `${head}${buttons} ${tail}`;
            }
        }

        return addMarkupToLine(line);
    });
    return lines.join("\n");
}

export function getUserPresentStatus(credentials) {
    const parsed = parseAttestationObject(credentials.response.attestationObject);
    console.log(parsed.authData.flags);
    return parsed.authData.flags.userPresent;
}
