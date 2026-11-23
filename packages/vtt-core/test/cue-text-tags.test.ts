// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { VTTParser, WebVTTParseCueText, WebVTTVoice, WebVTTText, WebVTTBold } from "../src";
import type VTTCue from "../src/VTTCue";

function cuesOf(body: string) {
    return new VTTParser(`WEBVTT\n\n${body}`).cues;
}

function singleCue(text: string): VTTCue {
    const cues = cuesOf(`00:00:00.000 --> 00:00:01.000\n${text}\n`);
    expect(cues).toHaveLength(1);
    return cues[0]!;
}

describe("WebVTT voice (speaker) tags in the parsed node tree", () => {
    it("attaches the voice node to the tree and makes it the parent of following content", () => {
        const list = WebVTTParseCueText("<v Roger>hello</v>");
        expect(list.children).toHaveLength(1);
        const voice = list.children[0]!;
        expect(voice).toBeInstanceOf(WebVTTVoice);
        expect((voice as WebVTTVoice).value).toBe("Roger");
        expect(voice.children).toHaveLength(1);
        expect(voice.children[0]).toBeInstanceOf(WebVTTText);
        expect((voice.children[0] as WebVTTText).value).toBe("hello");
    });

    it("falls back to the parent after the voice tag is closed", () => {
        const list = WebVTTParseCueText("<v Roger>hi</v>there");
        expect(list.children).toHaveLength(2);
        expect(list.children[0]).toBeInstanceOf(WebVTTVoice);
        expect(list.children[1]).toBeInstanceOf(WebVTTText);
        expect((list.children[1] as WebVTTText).value).toBe("there");
    });

    it("nests other tags inside the voice node", () => {
        const list = WebVTTParseCueText("<v Roger><b>loud</b></v>");
        const voice = list.children[0]!;
        expect(voice).toBeInstanceOf(WebVTTVoice);
        expect(voice.children[0]).toBeInstanceOf(WebVTTBold);
    });
});

describe("WebVTT voice (speaker) tags in getCueAsHTML", () => {
    it("renders the voice span with the speaker as title around its text", () => {
        const frag = singleCue("<v Roger>hello</v>").getCueAsHTML();
        const span = frag.querySelector("span");
        expect(span).not.toBeNull();
        expect(span!.getAttribute("title")).toBe("Roger");
        expect(span!.textContent).toBe("hello");
        expect(frag.textContent).toBe("hello");
    });

    it("keeps text after the closing tag outside the voice span", () => {
        const frag = singleCue("<v Roger>hi</v> there").getCueAsHTML();
        const span = frag.querySelector("span");
        expect(span!.getAttribute("title")).toBe("Roger");
        expect(span!.textContent).toBe("hi");
        expect(frag.textContent).toBe("hi there");
        // the trailing text must be a direct sibling of the span, not its child
        expect(frag.childNodes[frag.childNodes.length - 1]!.textContent).toBe(" there");
    });

    it("renders nested tags inside the voice span", () => {
        const frag = singleCue("<v Roger><b>loud</b> soft</v> after").getCueAsHTML();
        const span = frag.querySelector("span[title='Roger']");
        expect(span).not.toBeNull();
        expect(span!.querySelector("b")!.textContent).toBe("loud");
        expect(span!.textContent).toBe("loud soft");
        expect(frag.textContent).toBe("loud soft after");
    });

    it("carries classes and an empty annotation when none is given", () => {
        const frag = singleCue("<v.loud>hi</v>").getCueAsHTML();
        const span = frag.querySelector("span")!;
        expect(span.getAttribute("class")).toBe("loud");
        expect(span.getAttribute("title")).toBe("");
        expect(span.textContent).toBe("hi");
    });
});

describe("WebVTT unclosed tags and cue isolation", () => {
    it("puts text after an unclosed voice tag inside the voice span of that cue only", () => {
        const cues = cuesOf(
            `00:00:00.000 --> 00:00:01.000\n<v Roger>hello\n\n` +
            `00:00:01.000 --> 00:00:02.000\nworld\n`
        );
        expect(cues).toHaveLength(2);

        const first = cues[0]!.getCueAsHTML();
        const span = first.querySelector("span");
        expect(span).not.toBeNull();
        expect(span!.getAttribute("title")).toBe("Roger");
        expect(span!.textContent).toBe("hello");

        // the unclosed tag in the first cue must not swallow the second cue's text
        const second = cues[1]!.getCueAsHTML();
        expect(second.querySelector("span")).toBeNull();
        expect(second.textContent).toBe("world");
    });

    it("does not leak an unclosed formatting tag into the next cue", () => {
        const cues = cuesOf(
            `00:00:00.000 --> 00:00:01.000\n<b>bold\n\n` +
            `00:00:01.000 --> 00:00:02.000\nplain\n`
        );
        expect(cues).toHaveLength(2);

        const first = cues[0]!.getCueAsHTML();
        expect(first.querySelector("b")!.textContent).toBe("bold");

        const second = cues[1]!.getCueAsHTML();
        expect(second.querySelector("b")).toBeNull();
        expect(second.textContent).toBe("plain");
    });

    it("keeps consecutive cues with different tags independent", () => {
        const cues = cuesOf(
            `00:00:00.000 --> 00:00:01.000\n<v Alice>one</v>\n\n` +
            `00:00:01.000 --> 00:00:02.000\n<v Bob>two</v>\n\n` +
            `00:00:02.000 --> 00:00:03.000\nthree\n`
        );
        expect(cues).toHaveLength(3);

        const first = cues[0]!.getCueAsHTML();
        expect(first.querySelector("span")!.getAttribute("title")).toBe("Alice");
        expect(first.textContent).toBe("one");

        const second = cues[1]!.getCueAsHTML();
        expect(second.querySelector("span")!.getAttribute("title")).toBe("Bob");
        expect(second.textContent).toBe("two");

        const third = cues[2]!.getCueAsHTML();
        expect(third.querySelector("span")).toBeNull();
        expect(third.textContent).toBe("three");
    });

    it("ignores a stray voice end tag", () => {
        const frag = singleCue("hello</v> world").getCueAsHTML();
        expect(frag.querySelector("span")).toBeNull();
        expect(frag.textContent).toBe("hello world");
    });
});
