import DomSmith from '../../lib/dom/DomSmith.js';

/**
 * SubtitleRendererIsd is a plugin renderer for subtitles in TTML format.
 * It is registered with the Subtitles component and creates DOM output from `isd` (Intermediate Synchronic Document) subtitle cues.
 * The renderer currently supports _very_ basic structure parsing (`div`, `p`, `span`, `br`) and ignores formatting and styling instructions.
 * This component is intended for rendering embedded TTML subtitles provided by streaming engines like DASH.js.
 * @exports module:src/text/SubtitleRendererIsd
 * @author  Frank Kudermann - alphanull
 * @version 1.1.0
 * @license MIT
 */
export default class SubtitleRendererIsd {

    #dom;

    #subtitleTtml;

    /**
     * Active cue map managed by this renderer.
     * @type {Map<any, { ele: HTMLElement }>}
     */
    #currentCues = new Map();

    /**
     * Creates a new TTML subtitle renderer and registers it with the parent Subtitles component.
     * @param {module:src/core/Player}    player  Main player instance.
     * @param {module:src/text/Subtitles} parent  The parent Subtitles component.
     */
    constructor(player, parent) {

        parent.registerRenderer(this);

        this.#dom = new DomSmith({
            _ref: 'root',
            className: 'vip-subtitles-container vip-subtitles-isd'
        }, parent.getElement());

    }

    /**
     * Determines whether this renderer is suitable for rendering the given cue.
     * It only renders cues that contain an `isd` object and no `text`.
     * @param   {Object}  cue  The subtitle cue object.
     * @returns {boolean}      True if this renderer can handle the cue, false otherwise.
     */
    canRender(cue) { // eslint-disable-line class-methods-use-this

        return !cue.text && cue.isd;

    }

    /**
     * Syncs active cues with the renderer, adding new ones and removing inactive ones.
     * @param {TextTrackCue[]} activeCues  Currently active cues.
     */
    update(activeCues = []) {

        this.#currentCues.forEach((info, cue) => {
            if (!activeCues.includes(cue)) this.#removeCue(cue);
        });

        activeCues.forEach(cue => {
            if (!this.#currentCues.has(cue) && this.canRender(cue)) this.render(cue);
        });

    }

    /**
     * Renders a TTML subtitle cue to the DOM using DomSmith.
     * The rendered node is stored internally so it can be removed later.
     * @param {Object} cue  The subtitle cue to render.
     */
    render(cue) {

        this.#subtitleTtml = new DomSmith({
            _ref: 'subtitleTtml',
            className: 'vip-subtitle-item',
            _nodes: this.#renderIsd(cue.isd.contents)
        }, this.#dom.root);

        this.#currentCues.set(cue, { ele: this.#subtitleTtml.subtitleTtml, renderer: this });

    }

    /**
     * Recursively converts ISD (Intermediate Synchronic Document) structure into a DOMSmith node tree.
     * Currently only supports `div`, `p`, `span`, and `br` elements with optional text content.
     * @param   {Array} contents  The TTML ISD contents array.
     * @returns {Array}           Array of DomSmith node descriptors.
     */
    #renderIsd(contents) {

        let result = [];

        contents.forEach(content => {

            let newNode;

            if (['div', 'p', 'span', 'br'].includes(content.kind)) {
                newNode = { _tag: content.kind };
                if (content.kind === 'p') newNode.className = 'vip-subtitle-text';
                if (content.text) newNode._nodes = [content.text];
            }

            if (newNode) result.push(newNode);

            if (content.contents && content.contents.length) {
                if (newNode) newNode._nodes = this.#renderIsd(content.contents);
                else result = this.#renderIsd(content.contents);
            }

        });

        return result;

    }

    /**
     * Remove a single cue from DOM and state.
     * @param {TextTrackCue} cue  Cue to remove.
     */
    #removeCue(cue) {

        const cueEntry = this.#currentCues.get(cue);
        if (!cueEntry) return;

        cueEntry.ele?.remove();
        this.#currentCues.delete(cue);

    }

    /**
     * Clears the current subtitle output.
     */
    clear() {

        if (!this.#dom) return;

        this.#currentCues.forEach(({ ele }) => ele?.remove());
        this.#currentCues.clear();
        this.#dom.root.innerHTML = '';

    }

    /**
     * Destroys the renderer and cleans up DOM and references.
     */
    destroy() {

        this.clear();
        this.#dom.destroy();
        this.#subtitleTtml?.destroy();
        this.#dom = this.#subtitleTtml = null;
    }

}
