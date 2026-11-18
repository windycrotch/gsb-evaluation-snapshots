import { afterEach, describe, expect, it, vi } from "vitest";

import { PreviewStream, previewCodec, previewRefusal } from "./preview-stream";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

type Bytes = Uint8Array<ArrayBuffer>;

function u32(value: number): Bytes {
    return new Uint8Array([
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
    ]);
}

function concat(parts: Bytes[]): Bytes {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        joined.set(part, at);
        at += part.length;
    }
    return joined;
}

function box(type: string, ...payload: Bytes[]): Bytes {
    const body = concat(payload);
    const header = new Uint8Array(8);
    header.set(u32(body.length + 8), 0);
    for (let index = 0; index < 4; index += 1) {
        header[4 + index] = type.charCodeAt(index);
    }
    return concat([header, body]);
}

/** A visual sample entry with a 78-byte fixed body, as an MP4 track stores one. */
function sampleEntry(type: string, ...children: Bytes[]): Bytes {
    return box(type, new Uint8Array(78), ...children);
}

/** `stsd` is a full box: version/flags, then the entry count. */
function init(...entries: Bytes[]): Bytes {
    const stsd = new Uint8Array(8);
    stsd.set(u32(0), 0);
    stsd.set(u32(entries.length), 4);
    const moov = box(
        "moov",
        box("trak", box("mdia", box("minf", box("stbl", box("stsd", stsd, ...entries))))),
    );
    return concat([box("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x6d])), moov]);
}

describe("previewCodec", () => {
    it("names an H.264 profile from its decoder configuration", () => {
        const bytes = init(sampleEntry("avc1", box("avcC", new Uint8Array([1, 0x64, 0x00, 0x28]))));

        expect(previewCodec(bytes)).toBe("avc1.640028");
    });

    it("names an AV1 profile, level, tier, and depth", () => {
        const config = new Uint8Array([0x81, 0x04, 0x4c]);
        const bytes = init(sampleEntry("av01", box("av1C", config)));

        expect(previewCodec(bytes)).toBe("av01.0.04M.10");
    });

    it("names an HEVC profile with its reversed compatibility bits", () => {
        const config = new Uint8Array([1, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 93]);
        const bytes = init(sampleEntry("hvc1", box("hvcC", config)));

        expect(previewCodec(bytes)).toBe("hvc1.1.6.L93.B0");
    });

    it("waits for the whole index instead of guessing at a partial one", () => {
        const bytes = init(sampleEntry("avc1", box("avcC", new Uint8Array([1, 0x4d, 0x40, 0x1f]))));

        // Everything up to and including `moov`'s header is complete but the box is not.
        expect(previewCodec(bytes.subarray(0, bytes.length - 4))).toBeNull();
        expect(previewCodec(bytes)).toBe("avc1.4d401f");
    });

    it("reports nothing when the index has no readable track", () => {
        expect(previewCodec(concat([box("ftyp", new Uint8Array(4))]))).toBeNull();
        expect(previewCodec(init())).toBeNull();
    });
});

describe("previewRefusal", () => {
    it("keeps the encoder's own diagnostic from the refusal", async () => {
        const response = new Response(
            JSON.stringify({
                code: "engine_failed",
                message:
                    "The encoder could not produce the scene preview: Svt[error]: SVT-AV1-Essential only supports 10-bit encoding by design",
                detail: null,
                hint: "The source or encoder may not support a preview.",
            }),
            { status: 422, headers: { "content-type": "application/json" } },
        );

        expect(await previewRefusal(response)).toBe(
            "The encoder could not produce the scene preview: Svt[error]: SVT-AV1-Essential only supports 10-bit encoding by design",
        );
    });

    it("falls back to the status when the refusal is not JSON", async () => {
        const response = new Response("<html>proxy error</html>", { status: 503 });

        expect(await previewRefusal(response)).toBe("The preview could not be prepared (503).");
    });
});

function fakeVideo() {
    const element = new EventTarget() as unknown as HTMLVideoElement & {
        buffered: {
            length: number;
            start: (index: number) => number;
            end: (index: number) => number;
        };
        currentTime: number;
        paused: boolean;
        src: string;
        load: () => void;
        removeAttribute: () => void;
    };
    element.buffered = { length: 1, start: () => 0, end: () => 20 };
    element.currentTime = 0;
    element.paused = true;
    element.load = vi.fn();
    element.removeAttribute = vi.fn();
    return element;
}

/** A fragmented-MP4 media fragment: a `moof` header plus its `mdat` payload. */
function fragment(): Bytes {
    return concat([box("moof", box("mfhd", u32(0))), box("mdat", new Uint8Array([0xaa, 0xbb]))]);
}

/** The four-character types of every complete top-level box in `bytes`. */
function boxesTopLevel(bytes: Bytes): string[] {
    const types: string[] = [];
    let at = 0;
    while (at + 8 <= bytes.length) {
        const size =
            (((bytes[at] ?? 0) << 24) |
                ((bytes[at + 1] ?? 0) << 16) |
                ((bytes[at + 2] ?? 0) << 8) |
                (bytes[at + 3] ?? 0)) >>>
            0;
        types.push(
            String.fromCharCode(
                bytes[at + 4] ?? 0,
                bytes[at + 5] ?? 0,
                bytes[at + 6] ?? 0,
                bytes[at + 7] ?? 0,
            ),
        );
        at += size;
    }
    return types;
}

/** A fetch body whose reads the test enqueues, closes, or errors on demand. */
function controlledBody() {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
        start(created) {
            controller = created;
        },
    });
    return {
        stream,
        push(bytes: Bytes): void {
            controller?.enqueue(bytes);
        },
        close(): void {
            controller?.close();
        },
        error(reason: Error): void {
            controller?.error(reason);
        },
    };
}

/** A MediaSource/SourceBuffer pair that finishes an append on the next microtask. */
function installMediaSource(addSourceBuffer?: () => EventTarget) {
    class Buffer extends EventTarget {
        timestampOffset = 0;
        appended: Uint8Array[] = [];
        appendBuffer = vi.fn((bytes: Uint8Array) => {
            this.appended.push(bytes);
            queueMicrotask(() => this.dispatchEvent(new Event("updateend")));
        });
        remove = vi.fn((_start: number, _end: number) => {
            queueMicrotask(() => this.dispatchEvent(new Event("updateend")));
        });
    }
    const buffer = new Buffer();
    class Media extends EventTarget {
        static isTypeSupported = () => true;
        readyState = "open";
        addSourceBuffer = addSourceBuffer ?? (() => buffer);
        constructor() {
            super();
            queueMicrotask(() => this.dispatchEvent(new Event("sourceopen")));
        }
    }
    vi.stubGlobal("MediaSource", Media);
    Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: vi.fn(() => "blob:preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: vi.fn(),
    });
    return { buffer, Media };
}

describe("PreviewStream", () => {
    it("opens a MediaSource, appends the init segment, and reports it playable", async () => {
        const { buffer } = installMediaSource();
        const bytes = init(sampleEntry("avc1", box("avcC", new Uint8Array([1, 0x64, 0x00, 0x28]))));
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(bytes, { headers: { "content-type": "video/mp4" } })),
        );
        const element = fakeVideo();
        const onPlayable = vi.fn();
        const onError = vi.fn();
        const stream = new PreviewStream(element, { onPlayable, onError });

        stream.open("http://service/api/media/1");
        await vi.waitFor(() => expect(onPlayable).toHaveBeenCalledOnce());
        // The element is paused with a full buffer, so the read parked on buffer appetite;
        // a pause releases it and the response's end-of-body drains the segment.
        await vi.waitFor(() => {
            element.dispatchEvent(new Event("pause"));
            expect(stream.idle).toBe(true);
        });

        expect(onError).not.toHaveBeenCalled();
        expect(stream.started).toBe(true);
        expect(stream.idle).toBe(true);
        expect(stream.supportsAppend).toBe(true);
        expect(buffer.appended.some((chunk) => chunk.length > 0)).toBe(true);
        expect(element.src).toBe("blob:preview");
    });

    it("places a later proxy at its offset and closes the object URL", async () => {
        const { buffer } = installMediaSource();
        const bytes = init(sampleEntry("av01", box("av1C", new Uint8Array([0x81, 0x04, 0x4c]))));
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(bytes)),
        );
        const element = fakeVideo();
        const stream = new PreviewStream(element);

        stream.open("http://service/api/media/1");
        await vi.waitFor(() => expect(stream.started).toBe(true));
        stream.append("http://service/api/media/2", 12);
        await vi.waitFor(() => {
            element.dispatchEvent(new Event("pause"));
            expect(stream.idle).toBe(true);
        });
        expect(buffer.timestampOffset).toBe(12);

        stream.close();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
        expect(element.removeAttribute).toHaveBeenCalledWith("src");
        expect(stream.started).toBe(false);
    });

    it("falls back to the element source when MediaSource rejects the codec", async () => {
        installMediaSource();
        (MediaSource as unknown as { isTypeSupported: () => boolean }).isTypeSupported = () =>
            false;
        const bytes = init(sampleEntry("hvc1", box("hvcC", new Uint8Array(13))));
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(bytes)),
        );
        const element = fakeVideo();
        const stream = new PreviewStream(element);

        stream.open("http://service/api/media/1");
        await vi.waitFor(() => expect(stream.supportsAppend).toBe(false));
        expect(element.src).toBe("http://service/api/media/1");
        expect(stream.started).toBe(false);
    });

    it("reports a refused proxy with the service's own reason", async () => {
        installMediaSource();
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response(JSON.stringify({ message: "The source cannot be decoded." }), {
                        status: 422,
                    }),
            ),
        );
        const onError = vi.fn();
        const stream = new PreviewStream(fakeVideo(), { onError });

        stream.open("http://service/api/media/1");
        await vi.waitFor(() =>
            expect(onError).toHaveBeenCalledWith("The source cannot be decoded."),
        );
    });

    it("explains a refusal without a JSON body using the status code", async () => {
        installMediaSource();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("upstream down", { status: 502 })),
        );
        const onError = vi.fn();
        const stream = new PreviewStream(fakeVideo(), { onError });

        stream.open("http://service/api/media/1");
        await vi.waitFor(() =>
            expect(onError).toHaveBeenCalledWith("The preview could not be prepared (502)."),
        );
    });

    it("unblocks a buffer-ahead read when the element is paused", async () => {
        const { buffer } = installMediaSource();
        const initBytes = init(
            sampleEntry("avc1", box("avcC", new Uint8Array([1, 0x64, 0x00, 0x28]))),
        );
        const body = controlledBody();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body.stream)),
        );
        const element = fakeVideo();
        const stream = new PreviewStream(element);

        stream.open("http://service/api/media/1");
        body.push(initBytes);
        await vi.waitFor(() => expect(stream.started).toBe(true));
        // The 20-second fake buffer is already far ahead, so this fragment parks the read.
        body.push(fragment());
        await vi.waitFor(() => expect(buffer.appended.length).toBeGreaterThanOrEqual(1));
        expect(stream.idle).toBe(false);

        element.dispatchEvent(new Event("pause"));
        body.close();
        await vi.waitFor(() => expect(stream.idle).toBe(true));
    });

    it("unblocks a buffer-ahead read when the playhead seeks", async () => {
        const { buffer } = installMediaSource();
        const initBytes = init(
            sampleEntry("avc1", box("avcC", new Uint8Array([1, 0x4d, 0x40, 0x1f]))),
        );
        const body = controlledBody();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body.stream)),
        );
        const element = fakeVideo();
        const stream = new PreviewStream(element);

        stream.open("http://service/api/media/1");
        body.push(initBytes);
        await vi.waitFor(() => expect(stream.started).toBe(true));
        body.push(fragment());
        await vi.waitFor(() => expect(buffer.appended.length).toBeGreaterThanOrEqual(1));
        expect(stream.idle).toBe(false);

        element.dispatchEvent(new Event("seeking"));
        body.close();
        await vi.waitFor(() => expect(stream.idle).toBe(true));
    });

    it("does not resume reading on a stray pause once the wait was released", async () => {
        installMediaSource();
        const initBytes = init(
            sampleEntry("avc1", box("avcC", new Uint8Array([1, 0x64, 0x00, 0x28]))),
        );
        const body = controlledBody();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body.stream)),
        );
        const element = fakeVideo();
        const stream = new PreviewStream(element);

        stream.open("http://service/api/media/1");
        body.push(initBytes);
        await vi.waitFor(() => expect(stream.started).toBe(true));
        body.push(fragment());
        element.dispatchEvent(new Event("pause"));
        // A second pause after the first released the wait must not resolve a later wait early.
        element.dispatchEvent(new Event("pause"));
        body.close();
        await vi.waitFor(() => expect(stream.idle).toBe(true));
    });

    it("says the preview never produced a picture when it breaks before the first frame", async () => {
        installMediaSource();
        const initBytes = init(
            sampleEntry("avc1", box("avcC", new Uint8Array([1, 0x64, 0x00, 0x28]))),
        );
        const body = controlledBody();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body.stream)),
        );
        const onError = vi.fn();
        const element = fakeVideo();
        const stream = new PreviewStream(element, { onError });

        stream.open("http://service/api/media/1");
        body.push(initBytes);
        await vi.waitFor(() => expect(stream.started).toBe(true));
        // Only the init segment was appended; no `moof`, so no picture was ever buffered.
        // Release the buffer-ahead wait so the failed read is observed as an interruption.
        element.dispatchEvent(new Event("pause"));
        body.error(new Error("encoder exited"));
        await vi.waitFor(() =>
            expect(onError).toHaveBeenCalledWith(
                "The preview stopped before it produced a picture. The service log has the reason.",
            ),
        );
    });

    it("says the scene was interrupted when the body breaks after frames were buffered", async () => {
        const { buffer } = installMediaSource();
        const initBytes = init(
            sampleEntry("avc1", box("avcC", new Uint8Array([1, 0x64, 0x00, 0x28]))),
        );
        const body = controlledBody();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body.stream)),
        );
        const onError = vi.fn();
        const element = fakeVideo();
        const stream = new PreviewStream(element, { onError });

        stream.open("http://service/api/media/1");
        body.push(concat([initBytes, fragment()]));
        await vi.waitFor(() => expect(buffer.appended.length).toBeGreaterThanOrEqual(1));
        // Release the buffer-ahead wait so the failed read is observed.
        element.dispatchEvent(new Event("pause"));
        body.error(new Error("encoder exited"));
        await vi.waitFor(() =>
            expect(onError).toHaveBeenCalledWith(
                "The preview stopped before this scene finished. The service log has the reason.",
            ),
        );
        expect(onError.mock.calls.some(([message]) => message.includes("produced a picture"))).toBe(
            false,
        );
    });

    it("trims only behind the retained window and serializes the remove with appends", async () => {
        const { buffer } = installMediaSource();
        const initBytes = init(
            sampleEntry("avc1", box("avcC", new Uint8Array([1, 0x64, 0x00, 0x28]))),
        );
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(initBytes)),
        );
        const element = fakeVideo();
        // The playhead is 30 seconds in; an 8-second retain window means trimming starts at 22.
        element.currentTime = 30;
        element.paused = false;
        const stream = new PreviewStream(element);

        stream.open("http://service/api/media/1");
        await vi.waitFor(() => expect(stream.started).toBe(true));
        element.dispatchEvent(new Event("timeupdate"));
        await vi.waitFor(() => expect(buffer.remove).toHaveBeenCalled());
        const [from, to] = buffer.remove.mock.calls[0] ?? [0, 0];
        expect(from).toBe(0);
        // The retain cut is at 30 - 8 = 22, but the fake buffer only reaches 20 and the
        // discard range is capped at what is actually buffered.
        expect(to).toBe(20);
    });

    it("keeps the retained window and does not trim while the playhead is near the start", async () => {
        const { buffer } = installMediaSource();
        const initBytes = init(
            sampleEntry("avc1", box("avcC", new Uint8Array([1, 0x64, 0x00, 0x28]))),
        );
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(initBytes)),
        );
        const element = fakeVideo();
        element.currentTime = 4;
        element.paused = false;
        const stream = new PreviewStream(element);

        stream.open("http://service/api/media/1");
        await vi.waitFor(() => expect(stream.started).toBe(true));
        element.dispatchEvent(new Event("timeupdate"));
        expect(buffer.remove).not.toHaveBeenCalled();
    });

    it("recovers an append over quota by discarding behind the playhead and retrying", async () => {
        const { buffer } = installMediaSource();
        const initBytes = init(
            sampleEntry("avc1", box("avcC", new Uint8Array([1, 0x64, 0x00, 0x28]))),
        );
        // The media fragment arrives as its own chunk, so the failed append is identifiable.
        const media = fragment();
        let mediaAttempts = 0;
        // A browser over quota rejects the append with this DOMException; the session makes
        // room and retries once instead of failing the preview.
        buffer.appendBuffer = vi.fn((bytes: Uint8Array) => {
            if (boxesTopLevel(bytes as Bytes).includes("moof")) {
                mediaAttempts += 1;
                if (mediaAttempts === 1) {
                    throw new DOMException("quota", "QuotaExceededError");
                }
            }
            queueMicrotask(() => buffer.dispatchEvent(new Event("updateend")));
        }) as typeof buffer.appendBuffer;
        const body = controlledBody();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body.stream)),
        );
        const element = fakeVideo();
        // Playhead far enough in that discarding to (time - 8s retain) covers a real range.
        element.buffered = { length: 1, start: () => 0, end: () => 20 };
        element.currentTime = 12;
        const onError = vi.fn();
        const stream = new PreviewStream(element, { onError });

        stream.open("http://service/api/media/1");
        body.push(initBytes);
        await vi.waitFor(() => expect(stream.started).toBe(true));
        // The init segment parked on buffer appetite; release it so the media fragment (the
        // next append) reaches the quota check.
        element.dispatchEvent(new Event("pause"));
        body.push(media);
        await vi.waitFor(() => expect(buffer.remove).toHaveBeenCalled());
        await vi.waitFor(() => expect(mediaAttempts).toBeGreaterThanOrEqual(2));
        expect(onError).not.toHaveBeenCalled();
        body.close();
    });

    it("treats a quota error delivered as an error event as recoverable too", async () => {
        const { buffer } = installMediaSource();
        const initBytes = init(
            sampleEntry("avc1", box("avcC", new Uint8Array([1, 0x64, 0x00, 0x28]))),
        );
        const media = fragment();
        const exceeded = new DOMException("quota", "QuotaExceededError");
        let mediaAttempts = 0;
        buffer.appendBuffer = vi.fn((bytes: Uint8Array) => {
            if (!boxesTopLevel(bytes as Bytes).includes("moof")) {
                queueMicrotask(() => buffer.dispatchEvent(new Event("updateend")));
                return;
            }
            mediaAttempts += 1;
            if (mediaAttempts === 1) {
                // Some engines report the failure asynchronously on the error event rather
                // than throwing; carry the exception so recovery still recognises its name.
                const failure = new Event("error");
                Object.defineProperty(failure, "error", { value: exceeded });
                queueMicrotask(() => buffer.dispatchEvent(failure));
                return;
            }
            queueMicrotask(() => buffer.dispatchEvent(new Event("updateend")));
        }) as typeof buffer.appendBuffer;
        const body = controlledBody();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body.stream)),
        );
        const element = fakeVideo();
        const onError = vi.fn();
        const stream = new PreviewStream(element, { onError });

        stream.open("http://service/api/media/1");
        body.push(initBytes);
        await vi.waitFor(() => expect(stream.started).toBe(true));
        element.dispatchEvent(new Event("pause"));
        body.push(media);
        await vi.waitFor(() => expect(mediaAttempts).toBeGreaterThanOrEqual(2));
        expect(onError).not.toHaveBeenCalled();
        body.close();
    });

    it("falls back even when addSourceBuffer itself rejects the codec", async () => {
        const { Media } = installMediaSource(() => {
            throw new DOMException("unsupported", "NotSupportedError");
        });
        (Media as unknown as { isTypeSupported: () => boolean }).isTypeSupported = () => true;
        const bytes = init(sampleEntry("hvc1", box("hvcC", new Uint8Array(13))));
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(bytes)),
        );
        const element = fakeVideo();
        const stream = new PreviewStream(element);

        stream.open("http://service/api/media/1");
        await vi.waitFor(() => expect(stream.supportsAppend).toBe(false));
        expect(element.src).toBe("http://service/api/media/1");
    });
});
