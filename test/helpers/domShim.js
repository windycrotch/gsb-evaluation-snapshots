/**
 * Minimal, self-contained DOM shim for the headless engine-switch tests.
 *
 * It implements only the surface that DomSmith, Player, Controller and Play touch - just enough to create
 * elements, assign properties/attributes, register and dispatch event handlers, and mount/remove nodes.
 * It is intentionally NOT a general purpose DOM implementation.
 * @module test/helpers/domShim
 */

class ClassList {

    constructor(element) {
        this.#element = element;
    }

    #element;

    #tokens = new Set();

    add(...tokens) {
        tokens.forEach(token => this.#tokens.add(token));
        this.#sync();
    }

    remove(...tokens) {
        tokens.forEach(token => this.#tokens.delete(token));
        this.#sync();
    }

    toggle(token, force) {
        const shouldHave = typeof force === 'boolean' ? force : !this.#tokens.has(token);
        if (shouldHave) this.add(token);
        else this.remove(token);
        return shouldHave;
    }

    contains(token) {
        return this.#tokens.has(token);
    }

    #sync() {
        this.#element.setAttribute('class', [...this.#tokens].join(' '));
    }

}

class Style {

    constructor() {
        this._props = new Map();

        // Emulate CSSStyleDeclaration: direct camelCase property assignment (style.display = 'none')
        // and cssText round-tripping, on top of the explicit setProperty/getPropertyValue API.
        return new Proxy(this, {
            get(target, prop) {
                if (prop in target) return target[prop];
                return target._props.get(camelToKebab(prop)) ?? '';
            },
            set(target, prop, value) {
                if (prop === 'cssText') {
                    target._props.clear();
                    String(value).split(';').map(part => part.trim()).filter(Boolean).forEach(decl => {
                        const [name, ...rest] = decl.split(':');
                        target._props.set(name.trim(), rest.join(':').trim());
                    });
                    return true;
                }
                if (prop in target) {
                    target[prop] = value;
                    return true;
                }
                if (value === '' || value === null || typeof value === 'undefined') target._props.delete(camelToKebab(prop));
                else target._props.set(camelToKebab(prop), String(value));
                return true;
            }
        });
    }

    setProperty(name, value) {
        this._props.set(name, String(value));
    }

    getPropertyValue(name) {
        return this._props.get(name) ?? '';
    }

    removeProperty(name) {
        this._props.delete(name);
    }

    get cssText() {
        return [...this._props.entries()].map(([name, value]) => `${name}: ${value};`).join(' ');
    }

}

function camelToKebab(name) {
    return name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
}

class ShimEvent {

    constructor(type) {
        this.type = type;
    }

}

/**
 * Event names exposed as `on*` IDL properties on shim elements, mirroring the subset DomSmith probes.
 * @type {string[]}
 */
const SHIM_DOM_EVENTS = [
    'click', 'pointerup', 'pointerdown', 'dblclick', 'mousedown', 'mouseup', 'mouseenter', 'mouseleave',
    'mousemove', 'mouseover', 'mouseout', 'focus', 'focusin', 'focusout', 'blur', 'input', 'change',
    'keydown', 'keyup', 'keypress', 'submit', 'reset', 'load', 'error', 'abort', 'play', 'pause',
    'canplay', 'ended', 'volumechange', 'resize', 'scroll', 'touchstart', 'touchend', 'touchmove'
];

class ShimElement {

    constructor(tagName = 'div') {
        this.tagName = String(tagName).toUpperCase();
        this.nodeType = 1;
        this.nodeName = this.tagName;
        this.namespaceURI = 'http://www.w3.org/1999/xhtml';
        this.classList = new ClassList(this);
        this._style = new Style();
        this.attributes = new Map();
        this.childNodes = [];
        this.parentNode = null;
        this._listeners = new Map();
        this.dataset = {};

        // Declare the common DOM event IDL properties (onclick, ...) so DomSmith's event detection
        // (getSupportedDomEvents iterating `for (key in ele)`) recognizes them as supported events.
        for (const name of SHIM_DOM_EVENTS) {
            this[`on${name}`] = null;
        }

        // Generic IDL property storage for arbitrary element properties DomSmith assigns directly
        // (disabled, ariaLabel, tabIndex, ...). Unknown properties land here instead of being dropped.
        const idl = new Map();
        this._idl = idl;

        return new Proxy(this, {
            get(target, prop, receiver) {
                // own prototype members (e.g. the `disabled` accessor) always win over generic IDL storage
                const own = Reflect.get(target, prop, receiver);
                if (typeof own !== 'undefined') return own;
                if (idl.has(prop)) return idl.get(prop);
                if (target.attributes.has(String(prop))) return target.attributes.get(String(prop));
                return undefined;
            },
            set(target, prop, value, receiver) {
                if (prop === 'style') {
                    target.style = value; // routed through the style accessor
                    return true;
                }
                if (Reflect.has(target, prop)) return Reflect.set(target, prop, value, receiver);
                idl.set(prop, value);
                return true;
            },
            has(target, prop) {
                return idl.has(prop) || Reflect.has(target, prop) || target.attributes.has(String(prop));
            }
        });
    }

    /**
     * Storage for arbitrary IDL properties assigned to the element (see Proxy in the constructor).
     * @type {Map<string, *>}
     */
    _idl;

    /**
     * Boolean reflected attribute, mirroring the HTMLButtonElement.disabled IDL property: assigning a boolean
     * stores an actual boolean (not a stringified content attribute), and the getter always returns a boolean.
     * @type {boolean}
     */
    get disabled() {
        return this._idl?.get('disabled') === true || this.attributes?.has('disabled') === true;
    }

    set disabled(value) {
        this._idl.set('disabled', Boolean(value));
        if (value) this.attributes.set('disabled', '');
        else this.attributes.delete('disabled');
    }

    /**
     * Style accessor: DomSmith assigns `style` either as a declaration string or leaves the object in place.
     * Coerce string assignments into the Style object instead of overwriting it.
     */
    get style() {
        return this._style;
    }

    set style(value) {
        if (value instanceof Style) {
            this._style = value;
        } else {
            this._style.cssText = String(value ?? '');
        }
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === 'class') {
            this.classList.constructor; // noop reference to keep linters calm about read order
            this.classList._tokens = new Set(String(value).split(/\s+/).filter(Boolean));
        }
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    hasAttribute(name) {
        return this.attributes.has(name);
    }

    appendChild(child) {
        if (child.nodeType === 11) { // document fragment
            [...child.childNodes].forEach(n => this.appendChild(n));
            return child;
        }
        child.parentNode?.removeChild(child);
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
    }

    insertBefore(child, reference) {
        if (child.nodeType === 11) {
            [...child.childNodes].forEach(n => this.insertBefore(n, reference));
            return child;
        }
        child.parentNode?.removeChild(child);
        const index = reference ? this.childNodes.indexOf(reference) : -1;
        if (index === -1) this.childNodes.push(child);
        else this.childNodes.splice(index, 0, child);
        child.parentNode = this;
        return child;
    }

    removeChild(child) {
        const index = this.childNodes.indexOf(child);
        if (index !== -1) {
            this.childNodes.splice(index, 1);
            child.parentNode = null;
        }
        return child;
    }

    contains(child) {
        if (child === this) return true;
        return this.childNodes.some(node => node.contains?.(child));
    }

    remove() {
        this.parentNode?.removeChild(this);
    }

    replaceChild(newChild, oldChild) {
        const index = this.childNodes.indexOf(oldChild);
        if (index !== -1) {
            this.childNodes.splice(index, 1, newChild);
            newChild.parentNode = this;
            oldChild.parentNode = null;
        }
        return oldChild;
    }

    addEventListener(type, handler) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(handler);
    }

    removeEventListener(type, handler) {
        this._listeners.get(type)?.delete(handler);
    }

    dispatchEvent(event) {
        this._listeners.get(event.type)?.forEach(handler => handler.call(this, event));
        return true;
    }

    /** Test helper: fire a simple DOM event like a user click. */
    fire(type) {
        this.dispatchEvent(new ShimEvent(type));
    }

    querySelectorAll() {
        return [];
    }

    closest() {
        return null;
    }

    get firstChild() {
        return this.childNodes[0] ?? null;
    }

    get nextSibling() {
        if (!this.parentNode) return null;
        const index = this.parentNode.childNodes.indexOf(this);
        return this.parentNode.childNodes[index + 1] ?? null;
    }

}

class ShimDocumentFragment extends ShimElement {

    constructor() {
        super('#document-fragment');
        this.nodeType = 11;
        this.nodeName = '#document-fragment';
    }

}

class ShimDocument {

    constructor() {
        this.head = new ShimElement('head');
        this.body = new ShimElement('body');
        this.documentElement = new ShimElement('html');
    }

    createElement(tagName) {
        return new ShimElement(tagName);
    }

    createTextNode(text) {
        const node = new ShimElement('#text');
        node.nodeType = 3;
        node.nodeName = '#text';
        node.textContent = String(text);
        return node;
    }

    createDocumentFragment() {
        return new ShimDocumentFragment();
    }

    querySelector(selector) {
        if (selector === '#test-target') return this.body;
        return null;
    }

    querySelectorAll() {
        return [];
    }

}

/**
 * Installs the DOM shim (plus the other browser globals Player needs) on the global object.
 * Must be called before importing any source modules.
 * @returns {{document: ShimDocument, window: Object}} The installed globals.
 */
export function installDomShim() {

    const document = new ShimDocument();

    const window = {
        chrome: {},
        requestIdleCallback: cb => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0),
        cancelIdleCallback: id => clearTimeout(id),
        requestAnimationFrame: cb => setTimeout(() => cb(Date.now()), 0),
        cancelAnimationFrame: id => clearTimeout(id),
        console
    };

    Object.assign(globalThis, {
        window,
        document,
        HTMLElement: ShimElement,
        DocumentFragment: ShimDocumentFragment,
        CSS: { supports: () => true },
        HTMLVideoElement: class HTMLVideoElement extends ShimElement {
            constructor() {
                super('video');
            }
        },
        HTMLAudioElement: class HTMLAudioElement extends ShimElement {
            constructor() {
                super('audio');
            }
        },
        IntersectionObserver: class IntersectionObserver {
            disconnect() {}
            observe() {}
            unobserve() {}
        }
    });

    // Node 20+ exposes navigator as a read-only global, so define it explicitly.
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
            userAgent: 'node-test-agent',
            vendor: '',
            platform: 'node'
        }
    });

    window.document = document;

    return { document, window };

}

export { ShimElement };
