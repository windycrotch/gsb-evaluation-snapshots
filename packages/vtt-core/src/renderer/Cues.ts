if (globalThis.document) {
class VTTNodeList extends HTMLElement {
    constructor() {
        super();
        this.applyStyles();
    }

    applyStyles() {
        const vertical = this.getAttribute('vertical') || "";
        const align = this.getAttribute('align') || "center";
        this.style.writingMode = vertical === "" ? 
                "horizontal-tb" : 
            vertical === "lr" ?
                "vertical-lr" : "vertical-rl";
        this.style.textAlign = align;
    }

    static get observedAttributes() {
        return ['vertical', 'align'];
    }

    attributeChangedCallback() {
        this.applyStyles();
    }
}

class VTTCueBackgroundBox extends HTMLElement {
    constructor() {
        super();
    }
}

class VTTRegionElement extends HTMLElement {
    constructor() {
        super();
    }
}

window.customElements.define('vtt-cue-root', VTTNodeList);
// XXX: 'v' is not a valid custom element name (it contains no hyphen), so voice
// spans cannot be upgraded; they still render as inline elements via the
// shadow stylesheet in TextTrackContainer.
window.customElements.define('vtt-cue-bgbox', VTTCueBackgroundBox);
window.customElements.define('vtt-region', VTTRegionElement);

}
