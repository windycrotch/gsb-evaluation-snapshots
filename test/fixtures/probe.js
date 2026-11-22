/* Browser-side instrumentation used by the automated tests.
 *
 * Injected with page.addInitScript() so it observes the app from before its
 * first script runs. It records:
 *   - live Web Audio edges (which sources are still connected)
 *   - created analyser nodes and their spectra
 *   - renders per WebGLRenderer instance, including renders from detached
 *     canvases (a fingerprint of a stale animation loop)
 *   - object URL creation/revocation
 * Nothing here is loaded by the application itself.
 */
(function () {
    'use strict';

    var probe = window.__probe = {
        nodes: [],
        analyserRefs: [],
        mediaSourceEls: [],
        renders: [],
        staleRenders: 0,
        renderers: [],
        contextLosses: 0,
        webglContexts: 0,
        objectUrlsCreated: 0,
        objectUrlsRevoked: 0,
        errors: []
    };

    window.addEventListener('error', function (event) {
        probe.errors.push(String(event.message || event.error || 'error'));
    });
    window.addEventListener('unhandledrejection', function (event) {
        probe.errors.push('unhandledrejection: ' + String(event.reason));
    });

    var nextNodeId = 0;

    function info(node) {
        if (!node || (typeof node !== 'object' && typeof node !== 'function')) return null;
        var existing = node.__probeInfo;
        if (existing) return existing;
        var kind = 'node';
        try {
            kind = (node.constructor && node.constructor.name) || 'node';
            if (window.AudioDestinationNode && node instanceof window.AudioDestinationNode) {
                kind = 'destination';
            }
        } catch (error) {
            kind = 'node';
        }
        existing = { id: ++nextNodeId, kind: kind, edges: [] };
        try {
            Object.defineProperty(node, '__probeInfo', { value: existing, configurable: true });
        } catch (error) {
            node.__probeInfo = existing;
        }
        probe.nodes.push(existing);
        return existing;
    }

    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    var AudioNodeProto = window.AudioNode && window.AudioNode.prototype;

    if (AudioNodeProto && AudioNodeProto.connect) {
        var connectNative = AudioNodeProto.connect;
        AudioNodeProto.connect = function (destination) {
            var from = info(this);
            var to = info(destination);
            if (from && to) from.edges.push({ dest: to.id, destKind: to.kind });
            return connectNative.apply(this, arguments);
        };

        var disconnectNative = AudioNodeProto.disconnect;
        AudioNodeProto.disconnect = function () {
            var from = info(this);
            if (from) {
                if (arguments.length === 0 ||
                    typeof arguments[0] === 'number' ||
                    typeof arguments[0] === 'string') {
                    from.edges = [];
                } else if (arguments[0] && typeof arguments[0] === 'object') {
                    var to = info(arguments[0]);
                    var destId = to ? to.id : null;
                    from.edges = from.edges.filter(function (edge) {
                        return edge.dest !== destId;
                    });
                } else {
                    from.edges = [];
                }
            }
            return disconnectNative.apply(this, arguments);
        };
    }

    if (AudioCtx && AudioCtx.prototype) {
        ['createAnalyser', 'createMediaElementSource', 'createGain'].forEach(function (method) {
            var native = AudioCtx.prototype[method];
            if (typeof native !== 'function') return;
            AudioCtx.prototype[method] = function () {
                var node = native.apply(this, arguments);
                if (method === 'createAnalyser') probe.analyserRefs.push(node);
                if (method === 'createMediaElementSource') probe.mediaSourceEls.push(arguments[0]);
                info(node);
                return node;
            };
        });
    }

    var getContextNative = window.HTMLCanvasElement && HTMLCanvasElement.prototype.getContext;
    if (getContextNative) {
        HTMLCanvasElement.prototype.getContext = function (type) {
            var context = getContextNative.apply(this, arguments);
            if (context && /webgl/i.test(String(type))) probe.webglContexts++;
            return context;
        };
    }

    if (window.URL) {
        var createUrl = URL.createObjectURL;
        var revokeUrl = URL.revokeObjectURL;
        URL.createObjectURL = function () {
            probe.objectUrlsCreated++;
            return createUrl.apply(URL, arguments);
        };
        URL.revokeObjectURL = function () {
            probe.objectUrlsRevoked++;
            return revokeUrl.apply(URL, arguments);
        };
    }

    probe.snapshot = function () {
        function count(selector) {
            return document.querySelectorAll(selector).length;
        }
        var connectedMediaSources = 0;
        var analysersToDestination = 0;
        var analysers = 0;
        var mediaSources = 0;
        probe.nodes.forEach(function (node) {
            if (node.kind === 'MediaElementAudioSourceNode') {
                mediaSources++;
                if (node.edges.length) connectedMediaSources++;
            }
            if (node.kind === 'AnalyserNode') {
                analysers++;
                if (node.edges.some(function (edge) { return edge.destKind === 'destination'; })) {
                    analysersToDestination++;
                }
            }
        });

        // Every media element handed to createMediaElementSource, with enough
        // state to prove a superseded one was really released.
        var mediaElements = probe.mediaSourceEls.map(function (element) {
            return {
                sameAsCurrent: element === document.querySelector('.audio-container audio'),
                connected: element.isConnected,
                hasSrc: element.hasAttribute('src'),
                paused: !!element.paused,
                readyState: element.readyState
            };
        });

        return {
            bodyCanvases: count('body > canvas'),
            canvases: count('canvas'),
            audioElements: count('audio'),
            connectedMediaSources: connectedMediaSources,
            mediaSourceNodes: mediaSources,
            mediaElements: mediaElements,
            analysersCreated: analysers,
            analysersToDestination: analysersToDestination,
            webglContexts: probe.webglContexts,
            objectUrlsCreated: probe.objectUrlsCreated,
            objectUrlsRevoked: probe.objectUrlsRevoked,
            staleRenders: probe.staleRenders,
            contextLosses: probe.contextLosses,
            errors: probe.errors.slice()
        };
    };

    // Peak frequency bin of whichever analyser is still wired to the output.
    probe.spectrum = function () {
        var live = probe.analyserRefs.filter(function (node) {
            var meta = node && node.__probeInfo;
            return meta && meta.edges.some(function (edge) {
                return edge.destKind === 'destination';
            });
        });
        var analyser = live[live.length - 1];
        if (!analyser) return null;
        var data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        var peak = 0;
        var total = 0;
        for (var i = 0; i < data.length; i++) {
            if (data[i] > data[peak]) peak = i;
            total += data[i];
        }
        return {
            liveAnalysers: live.length,
            peakBin: peak,
            peakValue: data[peak],
            total: total,
            binCount: data.length,
            sampleRate: analyser.context.sampleRate,
            frequency: peak * analyser.context.sampleRate / analyser.fftSize
        };
    };

    probe.activeRendererIds = function (windowMs) {
        var cutoff = performance.now() - (windowMs || 400);
        var ids = {};
        probe.renders.forEach(function (entry) {
            if (entry.t >= cutoff) ids[entry.id] = true;
        });
        return Object.keys(ids).map(Number);
    };

    probe.lastRendererId = function () {
        var last = probe.renderers[probe.renderers.length - 1];
        return last ? last.__probeRendererId : null;
    };

    probe.renderCount = function (rendererId) {
        return probe.renders.filter(function (entry) {
            return entry.id === rendererId;
        }).length;
    };

    probe.resetRenders = function () {
        probe.renders.length = 0;
        probe.staleRenders = 0;
    };

    function instrumentThree() {
        var THREE = window.THREE;
        if (!THREE || typeof THREE.WebGLRenderer !== 'function') return;
        if (THREE.WebGLRenderer.__probeWrapped) return;
        var NativeRenderer = THREE.WebGLRenderer;
        var nextRendererId = 0;

        function ProbeRenderer() {
            var instance = Reflect.construct(NativeRenderer, arguments);
            var id = ++nextRendererId;
            instance.__probeRendererId = id;

            var renderNative = instance.render;
            if (typeof renderNative === 'function') {
                instance.render = function () {
                    var attached = !!(instance.domElement && instance.domElement.isConnected);
                    probe.renders.push({ id: id, t: performance.now(), attached: attached });
                    if (probe.renders.length > 4000) probe.renders.splice(0, 2000);
                    if (!attached) probe.staleRenders++;
                    return renderNative.apply(instance, arguments);
                };
            }

            var loseNative = instance.forceContextLoss;
            if (typeof loseNative === 'function') {
                instance.forceContextLoss = function () {
                    probe.contextLosses++;
                    return loseNative.apply(instance, arguments);
                };
            }

            probe.renderers.push(instance);
            return instance;
        }

        ProbeRenderer.prototype = NativeRenderer.prototype;
        Object.keys(NativeRenderer).forEach(function (key) {
            try { ProbeRenderer[key] = NativeRenderer[key]; } catch (error) { }
        });
        ProbeRenderer.__probeWrapped = true;
        THREE.WebGLRenderer = ProbeRenderer;
    }

    // Scripts (including THREE) are parsed before load; this runs before
    // window.onload handlers, which is where the app builds its first session.
    window.addEventListener('load', instrumentThree);
})();
