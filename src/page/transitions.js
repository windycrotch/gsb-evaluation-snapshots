// Scene transitions: two frames and a progress go in, one frame comes out. The viewer and the renderer both use this
// file, so a transition looks the same in the preview and in the MP4. Served at /__motlab/transitions.js.
//
// The shaders are from gl-transitions 1.43.0 (https://github.com/gl-transitions/gl-transitions), each under the
// licence and by the author named next to it (all MIT). SimpleZoom is changed so it compiles in WebGL: its
// nQuick is computed inside transition() instead of at the top level.
import { ease } from './motion.js';

export const TRANSITIONS = {
  "fade": { author: "gre", license: "MIT", defaults: {}, types: {},
    glsl: "// author: gre\n// license: MIT\n\nvec4 transition (vec2 uv) {\n  return mix(\n    getFromColor(uv),\n    getToColor(uv),\n    progress\n  );\n}\n" },
  "fadecolor": { author: "gre", license: "MIT", defaults: {"color": [0, 0, 0], "colorPhase": 0.4}, types: {"color": "vec3", "colorPhase": "float"},
    glsl: "// author: gre\n// License: MIT\nuniform vec3 color;// = vec3(0.0)\nuniform float colorPhase/* = 0.4 */; // if 0.0, there is no black phase, if 0.9, the black phase is very important\nvec4 transition (vec2 uv) {\n  return mix(\n    mix(vec4(color, 1.0), getFromColor(uv), smoothstep(1.0-colorPhase, 0.0, progress)),\n    mix(vec4(color, 1.0), getToColor(uv), smoothstep(    colorPhase, 1.0, progress)),\n    progress);\n}\n" },
  "Directional": { author: "Gaëtan Renaudeau", license: "MIT", defaults: {"direction": [0, 1]}, types: {"direction": "vec2"},
    glsl: "// Author: Gaëtan Renaudeau\n// License: MIT\n\nuniform vec2 direction; // = vec2(0.0, 1.0)\n\nvec4 transition (vec2 uv) {\n  vec2 p = uv + progress * sign(direction);\n  vec2 f = fract(p);\n  return mix(\n    getToColor(f),\n    getFromColor(f),\n    step(0.0, p.y) * step(p.y, 1.0) * step(0.0, p.x) * step(p.x, 1.0)\n  );\n}\n" },
  "directionalwipe": { author: "gre", license: "MIT", defaults: {"direction": [1, -1], "smoothness": 0.5}, types: {"direction": "vec2", "smoothness": "float"},
    glsl: "// Author: gre\n// License: MIT\n\nuniform vec2 direction; // = vec2(1.0, -1.0)\nuniform float smoothness; // = 0.5\n \nconst vec2 center = vec2(0.5, 0.5);\n \nvec4 transition (vec2 uv) {\n  vec2 v = normalize(direction);\n  v /= abs(v.x)+abs(v.y);\n  float d = v.x * center.x + v.y * center.y;\n  float m =\n    (1.0-step(progress, 0.0)) * // there is something wrong with our formula that makes m not equals 0.0 with progress is 0.0\n    (1.0 - smoothstep(-smoothness, 0.0, v.x * uv.x + v.y * uv.y - (d-0.5+progress*(1.+smoothness))));\n  return mix(getFromColor(uv), getToColor(uv), m);\n}\n" },
  "directionalwarp": { author: "pschroen", license: "MIT", defaults: {"direction": [-1, 1]}, types: {"direction": "vec2"},
    glsl: "// Author: pschroen\n// License: MIT\n\nuniform vec2 direction; // = vec2(-1.0, 1.0)\n\nconst float smoothness = 0.5;\nconst vec2 center = vec2(0.5, 0.5);\n\nvec4 transition (vec2 uv) {\n  vec2 v = normalize(direction);\n  v /= abs(v.x) + abs(v.y);\n  float d = v.x * center.x + v.y * center.y;\n  float m = 1.0 - smoothstep(-smoothness, 0.0, v.x * uv.x + v.y * uv.y - (d - 0.5 + progress * (1.0 + smoothness)));\n  return mix(getFromColor((uv - 0.5) * (1.0 - m) + 0.5), getToColor((uv - 0.5) * m + 0.5), m);\n}\n" },
  "circleopen": { author: "gre", license: "MIT", defaults: {"smoothness": 0.3, "opening": true}, types: {"smoothness": "float", "opening": "bool"},
    glsl: "// author: gre\n// License: MIT\nuniform float smoothness; // = 0.3\nuniform bool opening; // = true\n\nconst vec2 center = vec2(0.5, 0.5);\nconst float SQRT_2 = 1.414213562373;\n\nvec4 transition (vec2 uv) {\n  float x = opening ? progress : 1.-progress;\n  float m = smoothstep(-smoothness, 0.0, SQRT_2*distance(center, uv) - x*(1.+smoothness));\n  return mix(getFromColor(uv), getToColor(uv), opening ? 1.-m : m);\n}\n" },
  "CrossZoom": { author: "rectalogic", license: "MIT", defaults: {"strength": 0.4}, types: {"strength": "float"},
    glsl: "// License: MIT\n// Author: rectalogic\n// ported by gre from https://gist.github.com/rectalogic/b86b90161503a0023231\n\n// Converted from https://github.com/rectalogic/rendermix-basic-effects/blob/master/assets/com/rendermix/CrossZoom/CrossZoom.frag\n// Which is based on https://github.com/evanw/glfx.js/blob/master/src/filters/blur/zoomblur.js\n// With additional easing functions from https://github.com/rectalogic/rendermix-basic-effects/blob/master/assets/com/rendermix/Easing/Easing.glsllib\n\nuniform float strength; // = 0.4\n\nconst float PI = 3.141592653589793;\n\nfloat Linear_ease(in float begin, in float change, in float duration, in float time) {\n    return change * time / duration + begin;\n}\n\nfloat Exponential_easeInOut(in float begin, in float change, in float duration, in float time) {\n    if (time == 0.0)\n        return begin;\n    else if (time == duration)\n        return begin + change;\n    time = time / (duration / 2.0);\n    if (time < 1.0)\n        return change / 2.0 * pow(2.0, 10.0 * (time - 1.0)) + begin;\n    return change / 2.0 * (-pow(2.0, -10.0 * (time - 1.0)) + 2.0) + begin;\n}\n\nfloat Sinusoidal_easeInOut(in float begin, in float change, in float duration, in float time) {\n    return -change / 2.0 * (cos(PI * time / duration) - 1.0) + begin;\n}\n\nfloat rand (vec2 co) {\n  return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453);\n}\n\nvec3 crossFade(in vec2 uv, in float dissolve) {\n    return mix(getFromColor(uv).rgb, getToColor(uv).rgb, dissolve);\n}\n\nvec4 transition(vec2 uv) {\n    vec2 texCoord = uv.xy / vec2(1.0).xy;\n\n    // Linear interpolate center across center half of the image\n    vec2 center = vec2(Linear_ease(0.25, 0.5, 1.0, progress), 0.5);\n    float dissolve = Exponential_easeInOut(0.0, 1.0, 1.0, progress);\n\n    // Mirrored sinusoidal loop. 0->strength then strength->0\n    float strength = Sinusoidal_easeInOut(0.0, strength, 0.5, progress);\n\n    vec3 color = vec3(0.0);\n    float total = 0.0;\n    vec2 toCenter = center - texCoord;\n\n    /* randomize the lookup values to hide the fixed number of samples */\n    float offset = rand(uv);\n\n    for (float t = 0.0; t <= 40.0; t++) {\n        float percent = (t + offset) / 40.0;\n        float weight = 4.0 * (percent - percent * percent);\n        color += crossFade(texCoord + toCenter * percent * strength, dissolve) * weight;\n        total += weight;\n    }\n    return vec4(color / total, 1.0);\n}\n" },
  "crosswarp": { author: "Eke Péter <peterekepeter@gmail.com>", license: "MIT", defaults: {}, types: {},
    glsl: "// Author: Eke Péter <peterekepeter@gmail.com>\n// License: MIT\nvec4 transition(vec2 p) {\n  float x = progress;\n  x=smoothstep(.0,1.0,(x*2.0+p.x-1.0));\n  return mix(getFromColor((p-.5)*(1.-x)+.5), getToColor((p-.5)*x+.5), x);\n}\n" },
  "SimpleZoom": { author: "0gust1", license: "MIT", defaults: {"zoom_quickness": 0.8}, types: {"zoom_quickness": "float"},
    glsl: "// Author: 0gust1\n// License: MIT\n\nuniform float zoom_quickness; // = 0.8\n\nvec2 zoom(vec2 uv, float amount) {\n  return 0.5 + ((uv - 0.5) * (1.0-amount));\t\n}\n\nvec4 transition (vec2 uv) {\n  float nQuick = clamp(zoom_quickness,0.2,1.0);\n  return mix(\n    getFromColor(zoom(uv, smoothstep(0.0, nQuick, progress))),\n    getToColor(uv),\n   smoothstep(nQuick-0.2, 1.0, progress)\n  );\n}" },
  "LinearBlur": { author: "gre", license: "MIT", defaults: {"intensity": 0.1}, types: {"intensity": "float"},
    glsl: "// author: gre\n// license: MIT\nuniform float intensity; // = 0.1\nconst int passes = 6;\n\nvec4 transition(vec2 uv) {\n    vec4 c1 = vec4(0.0);\n    vec4 c2 = vec4(0.0);\n\n    float disp = intensity*(0.5-distance(0.5, progress));\n    for (int xi=0; xi<passes; xi++)\n    {\n        float x = float(xi) / float(passes) - 0.5;\n        for (int yi=0; yi<passes; yi++)\n        {\n            float y = float(yi) / float(passes) - 0.5;\n            vec2 v = vec2(x,y);\n            float d = disp;\n            c1 += getFromColor( uv + d*v);\n            c2 += getToColor( uv + d*v);\n        }\n    }\n    c1 /= float(passes*passes);\n    c2 /= float(passes*passes);\n    return mix(c1, c2, progress);\n}\n" },
  "cube": { author: "gre", license: "MIT", defaults: {"persp": 0.7, "unzoom": 0.3, "reflection": 0.4, "floating": 3}, types: {"persp": "float", "unzoom": "float", "reflection": "float", "floating": "float"},
    glsl: "// Author: gre\n// License: MIT\nuniform float persp; // = 0.7\nuniform float unzoom; // = 0.3\nuniform float reflection; // = 0.4\nuniform float floating; // = 3.0\n\nvec2 project (vec2 p) {\n  return p * vec2(1.0, -1.2) + vec2(0.0, -floating/100.);\n}\n\nbool inBounds (vec2 p) {\n  return all(lessThan(vec2(0.0), p)) && all(lessThan(p, vec2(1.0)));\n}\n\nvec4 bgColor (vec2 p, vec2 pfr, vec2 pto) {\n  vec4 c = vec4(0.0, 0.0, 0.0, 1.0);\n  pfr = project(pfr);\n  // FIXME avoid branching might help perf!\n  if (inBounds(pfr)) {\n    c += mix(vec4(0.0), getFromColor(pfr), reflection * mix(1.0, 0.0, pfr.y));\n  }\n  pto = project(pto);\n  if (inBounds(pto)) {\n    c += mix(vec4(0.0), getToColor(pto), reflection * mix(1.0, 0.0, pto.y));\n  }\n  return c;\n}\n\n// p : the position\n// persp : the perspective in [ 0, 1 ]\n// center : the xcenter in [0, 1] \\ 0.5 excluded\nvec2 xskew (vec2 p, float persp, float center) {\n  float x = mix(p.x, 1.0-p.x, center);\n  return (\n    (\n      vec2( x, (p.y - 0.5*(1.0-persp) * x) / (1.0+(persp-1.0)*x) )\n      - vec2(0.5-distance(center, 0.5), 0.0)\n    )\n    * vec2(0.5 / distance(center, 0.5) * (center<0.5 ? 1.0 : -1.0), 1.0)\n    + vec2(center<0.5 ? 0.0 : 1.0, 0.0)\n  );\n}\n\nvec4 transition(vec2 op) {\n  float uz = unzoom * 2.0*(0.5-distance(0.5, progress));\n  vec2 p = -uz*0.5+(1.0+uz) * op;\n  vec2 fromP = xskew(\n    (p - vec2(progress, 0.0)) / vec2(1.0-progress, 1.0),\n    1.0-mix(progress, 0.0, persp),\n    0.0\n  );\n  vec2 toP = xskew(\n    p / vec2(progress, 1.0),\n    mix(pow(progress, 2.0), 1.0, persp),\n    1.0\n  );\n  // FIXME avoid branching might help perf!\n  if (inBounds(fromP)) {\n    return getFromColor(fromP);\n  }\n  else if (inBounds(toP)) {\n    return getToColor(toP);\n  }\n  return bgColor(op, fromP, toP);\n}\n" },
};

export const transitionNames = Object.keys(TRANSITIONS);
export const findTransition = name => {
  const key = transitionNames.find(k => k.toLowerCase() === String(name).toLowerCase());
  if (!key) throw new Error(`unknown transition "${name}"; use one of: ${transitionNames.join(', ')}`);
  return { name: key, ...TRANSITIONS[key] };
};

// Frame k of a transition that lasts n frames. The middle of each frame, so neither the first nor the last frame is
// a plain copy of one scene. Easing names are the ones in motion.js (default inOutCubic).
export function transitionProgress(k, n, easing = 'inOutCubic') {
  const e = ease[easing];
  if (!e) throw new Error(`unknown ease "${easing}"; use one of: ${Object.keys(ease).join(', ')}`);
  return e((k + 0.5) / n);
}

const VERT = 'attribute vec2 p; varying vec2 vUv; void main() { vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }';
const frag = glsl => `precision highp float;
varying vec2 vUv; uniform sampler2D uFrom, uTo; uniform float progress, ratio;
vec4 getFromColor(vec2 uv) { return texture2D(uFrom, uv); }
vec4 getToColor(vec2 uv) { return texture2D(uTo, uv); }
${glsl}
void main() { gl_FragColor = transition(vUv); }`;

// One WebGL canvas that mixes two canvases (or images, or video frames). draw() returns that canvas; copy it onto
// the frame with drawImage right away.
export function createMixer() {
  const cv = document.createElement('canvas');
  const gl = cv.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
  if (!gl) throw new Error('scene transitions need WebGL2');
  const programs = new Map(), textures = [gl.createTexture(), gl.createTexture()];
  for (const t of textures) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);   // one triangle over the frame
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  function program(name) {
    if (programs.has(name)) return programs.get(name);
    const t = findTransition(name), p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, frag(t.glsl)]]) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`transition ${t.name}: ${gl.getShaderInfoLog(s)}`);
      gl.attachShader(p, s);
    }
    gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`transition ${t.name}: ${gl.getProgramInfoLog(p)}`);
    const entry = { p, t, u: n => gl.getUniformLocation(p, n) };
    programs.set(name, entry); return entry;
  }

  return {
    canvas: cv,
    draw(name, from, to, progress, params = {}) {
      const w = from.width, h = from.height;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const { p, t, u } = program(name);
      gl.viewport(0, 0, w, h); gl.useProgram(p);
      [from, to].forEach((img, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, textures[i]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); });
      gl.uniform1i(u('uFrom'), 0); gl.uniform1i(u('uTo'), 1); gl.uniform1f(u('progress'), progress); gl.uniform1f(u('ratio'), w / h);
      for (const [k, type] of Object.entries(t.types)) {
        const v = params[k] ?? t.defaults[k], loc = u(k);
        if (loc === null || v === undefined) continue;
        if (type === 'float') gl.uniform1f(loc, v);
        else if (type === 'bool' || type === 'int') gl.uniform1i(loc, Number(v));
        else gl[`uniform${type.slice(3)}fv`](loc, v);   // vec2, vec3, vec4
      }
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return cv;
    },
  };
}
