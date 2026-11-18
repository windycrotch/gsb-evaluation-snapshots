// src/renderer/webgl.js

class VexelWebGLRenderer {
    constructor(vexel) {
        this.vexel = vexel;
        this.gl = null;
        this.canvas = null;
        this.pixelRatio = 1;
        this.programs = {};
        this.buffers = {};
        this.initialized = false;
        this.maxTextureSize = 4096;
        this.batchSize = 1000;
        this.drawCalls = 0;
    }

    init() {
        try {
            this.pixelRatio = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(this.vexel.width * this.pixelRatio));
            canvas.height = Math.max(1, Math.round(this.vexel.height * this.pixelRatio));
            if (this.vexel.canvas && this.vexel.canvas.style) {
                canvas.style.cssText = this.vexel.canvas.style.cssText;
            }
            canvas.style.width = this.vexel.width + 'px';
            canvas.style.height = this.vexel.height + 'px';
            this.canvas = canvas;

            const attrs = {
                alpha: true,
                antialias: true,
                premultipliedAlpha: true,
                preserveDrawingBuffer: false,
                powerPreference: 'high-performance'
            };

            let gl = null;
            try { gl = canvas.getContext('webgl2', attrs); } catch (e) { /* fall through */ }
            if (!gl) {
                try { gl = canvas.getContext('webgl', attrs); } catch (e) { /* fall through */ }
            }

            if (!gl) {
                console.warn('WebGL not supported, falling back to Canvas2D');
                this.canvas = null;
                return false;
            }
            this.gl = gl;

            if (!this._createShaders()) {
                console.warn('WebGL shader setup failed, falling back to Canvas2D');
                this._cleanupGL();
                return false;
            }

            this._createBuffers();
            this._setupState();

            this.initialized = true;
            return true;
        } catch (err) {
            console.warn('WebGL initialization failed, falling back to Canvas2D:', err);
            this._cleanupGL();
            return false;
        }
    }

    _cleanupGL() {
        const gl = this.gl;
        if (gl) {
            for (const key of Object.keys(this.buffers)) {
                if (this.buffers[key]) gl.deleteBuffer(this.buffers[key]);
            }
            for (const key of Object.keys(this.programs)) {
                if (this.programs[key] && this.programs[key].program) {
                    gl.deleteProgram(this.programs[key].program);
                }
            }
            const lose = gl.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
        }
        this.buffers = {};
        this.programs = {};
        this.gl = null;
        this.canvas = null;
        this.initialized = false;
    }

    _createShaders() {
        const vertexShaderSource = `
            attribute vec2 a_position;
            attribute vec4 a_color;
            attribute vec2 a_texCoord;
            uniform mat3 u_matrix;
            varying vec4 v_color;
            varying vec2 v_texCoord;
            void main() {
                vec3 position = u_matrix * vec3(a_position, 1.0);
                gl_Position = vec4(position.xy, 0.0, 1.0);
                v_color = a_color;
                v_texCoord = a_texCoord;
            }
        `;

        const fragmentShaderSource = `
            precision mediump float;
            varying vec4 v_color;
            varying vec2 v_texCoord;
            uniform sampler2D u_texture;
            uniform bool u_useTexture;
            void main() {
                if (u_useTexture) {
                    gl_FragColor = texture2D(u_texture, v_texCoord) * v_color;
                } else {
                    gl_FragColor = v_color;
                }
            }
        `;

        const program = this._compileShader(vertexShaderSource, fragmentShaderSource);
        if (!program) return false;
        this.programs.main = program;
        return true;
    }

    _compileShader(vertexSource, fragmentSource) {
        const gl = this.gl;

        const vertexShader = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vertexShader, vertexSource);
        gl.compileShader(vertexShader);

        if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
            console.error('Vertex shader error:', gl.getShaderInfoLog(vertexShader));
            return null;
        }

        const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fragmentShader, fragmentSource);
        gl.compileShader(fragmentShader);

        if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
            console.error('Fragment shader error:', gl.getShaderInfoLog(fragmentShader));
            return null;
        }

        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('Program link error:', gl.getProgramInfoLog(program));
            return null;
        }

        return {
            program,
            uniforms: {
                matrix: gl.getUniformLocation(program, 'u_matrix'),
                texture: gl.getUniformLocation(program, 'u_texture'),
                useTexture: gl.getUniformLocation(program, 'u_useTexture')
            },
            attributes: {
                position: gl.getAttribLocation(program, 'a_position'),
                color: gl.getAttribLocation(program, 'a_color'),
                texCoord: gl.getAttribLocation(program, 'a_texCoord')
            }
        };
    }

    _createBuffers() {
        const gl = this.gl;

        this.buffers.position = gl.createBuffer();
        this.buffers.color = gl.createBuffer();
        this.buffers.texCoord = gl.createBuffer();
        this.buffers.index = gl.createBuffer();
    }

    _setupState() {
        const gl = this.gl;

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearColor(0, 0, 0, 0);
    }

    resize(width, height) {
        if (!this.canvas) return;
        this.canvas.width = Math.max(1, Math.round(width * this.pixelRatio));
        this.canvas.height = Math.max(1, Math.round(height * this.pixelRatio));
        this.canvas.style.width = width + 'px';
        this.canvas.style.height = height + 'px';
    }

    begin() {
        const gl = this.gl;
        if (!gl) return;
        this.drawCalls = 0;

        // Self-heal if the logical canvas size changed (e.g. vexel.resize)
        const w = Math.max(1, Math.round(this.vexel.width * this.pixelRatio));
        const h = Math.max(1, Math.round(this.vexel.height * this.pixelRatio));
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.resize(this.vexel.width, this.vexel.height);
        }

        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        const program = this.programs.main;
        gl.useProgram(program.program);

        const matrix = this._getViewMatrix();
        gl.uniformMatrix3fv(program.uniforms.matrix, false, matrix);
        gl.uniform1i(program.uniforms.texture, 0);
        gl.uniform1i(program.uniforms.useTexture, 0);
    }

    end() {
        if (this.gl) this.gl.flush();
    }

    // Matches the Canvas2D transform exactly:
    //   screen = translate(vp.x, vp.y) * scale(zoom) * rotate(rotation) * world
    // then maps CSS-pixel screen coordinates into clip space (y flipped).
    _getViewMatrix() {
        const vp = this.vexel.viewport;
        const w = this.vexel.width;
        const h = this.vexel.height;

        const zoom = vp.zoom || 1;
        const rotation = vp.rotation || 0;
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);

        const sx = 2 / w;
        const sy = 2 / h;

        // Column-major mat3. For a world point (wx, wy):
        //   screenX = zoom * (cos*wx - sin*wy) + vp.x
        //   screenY = zoom * (sin*wx + cos*wy) + vp.y
        //   clipX = screenX * sx - 1
        //   clipY = 1 - screenY * sy
        return [
            zoom * cos * sx, -zoom * sin * sy, 0,
            -zoom * sin * sx, -zoom * cos * sy, 0,
            vp.x * sx - 1, 1 - vp.y * sy, 1
        ];
    }

    // Colors are packed as 0xRRGGBBAA.
    _unpackColor(color) {
        return [
            ((color >>> 24) & 0xFF) / 255,
            ((color >>> 16) & 0xFF) / 255,
            ((color >>> 8) & 0xFF) / 255,
            (color & 0xFF) / 255
        ];
    }

    _bindAndDraw(positions, color, mode) {
        const gl = this.gl;
        const program = this.programs.main;

        const [r, g, b, a] = this._unpackColor(color);

        const vertexCount = positions.length / 2;
        const colors = new Float32Array(vertexCount * 4);
        for (let i = 0; i < colors.length; i += 4) {
            colors[i] = r;
            colors[i + 1] = g;
            colors[i + 2] = b;
            colors[i + 3] = a;
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.position);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(program.attributes.position);
        gl.vertexAttribPointer(program.attributes.position, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.color);
        gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(program.attributes.color);
        gl.vertexAttribPointer(program.attributes.color, 4, gl.FLOAT, false, 0, 0);

        gl.drawArrays(mode, 0, vertexCount);
        this.drawCalls++;
    }

    // Computes the four on-canvas corners of a rectangle after the same
    // transform Canvas2D applies in VexelRectangle.draw():
    //   translate(cx, cy) -> rotate(rotation) -> scale(scaleX, scaleY)
    // where (cx, cy) is the rectangle center.
    _rectCorners(x, y, width, height, transform) {
        const t = transform || {};
        const sx = t.scaleX === undefined ? 1 : t.scaleX;
        const sy = t.scaleY === undefined ? 1 : t.scaleY;
        const rot = t.rotation || 0;

        const cx = x + width / 2;
        const cy = y + height / 2;
        const hw = width / 2;
        const hh = height / 2;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);

        return [
            [-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]
        ].map(([px, py]) => {
            const lx = px * sx;
            const ly = py * sy;
            return [
                cx + lx * cos - ly * sin,
                cy + lx * sin + ly * cos
            ];
        });
    }

    drawRect(x, y, width, height, color, transform) {
        const c = this._rectCorners(x, y, width, height, transform);

        const positions = new Float32Array([
            c[0][0], c[0][1], c[1][0], c[1][1], c[2][0], c[2][1],
            c[0][0], c[0][1], c[2][0], c[2][1], c[3][0], c[3][1]
        ]);

        this._bindAndDraw(positions, color, this.gl.TRIANGLES);
    }

    drawRectOutline(x, y, width, height, color, lineWidth = 1, transform) {
        const c = this._rectCorners(x, y, width, height, transform);
        for (let i = 0; i < 4; i++) {
            const p1 = c[i];
            const p2 = c[(i + 1) % 4];
            this.drawLine(p1[0], p1[1], p2[0], p2[1], color, lineWidth);
        }
    }

    drawEllipse(cx, cy, rx, ry, color, segments = 64, rotation = 0) {
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);

        const positions = [cx, cy];

        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const lx = Math.cos(angle) * rx;
            const ly = Math.sin(angle) * ry;
            positions.push(
                cx + lx * cos - ly * sin,
                cy + lx * sin + ly * cos
            );
        }

        this._bindAndDraw(new Float32Array(positions), color, this.gl.TRIANGLE_FAN);
    }

    drawEllipseOutline(cx, cy, rx, ry, color, lineWidth = 1, segments = 64, rotation = 0) {
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);

        const outerRx = rx + lineWidth / 2;
        const outerRy = ry + lineWidth / 2;
        const innerRx = Math.max(0, rx - lineWidth / 2);
        const innerRy = Math.max(0, ry - lineWidth / 2);

        const positions = [];
        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const ca = Math.cos(angle);
            const sa = Math.sin(angle);

            const olx = ca * outerRx;
            const oly = sa * outerRy;
            positions.push(cx + olx * cos - oly * sin, cy + olx * sin + oly * cos);

            const ilx = ca * innerRx;
            const ily = sa * innerRy;
            positions.push(cx + ilx * cos - ily * sin, cy + ilx * sin + ily * cos);
        }

        this._bindAndDraw(new Float32Array(positions), color, this.gl.TRIANGLE_STRIP);
    }

    drawLine(x1, y1, x2, y2, color, width = 1) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1e-9) return;

        // `width` is in world units, so the view matrix scales it with zoom
        // exactly like Canvas2D lineWidth.
        const nx = -dy / len * width / 2;
        const ny = dx / len * width / 2;

        const positions = new Float32Array([
            x1 + nx, y1 + ny, x1 - nx, y1 - ny, x2 + nx, y2 + ny,
            x1 - nx, y1 - ny, x2 - nx, y2 - ny, x2 + nx, y2 + ny
        ]);

        this._bindAndDraw(positions, color, this.gl.TRIANGLES);
    }

    drawPolygon(vertices, color) {
        if (vertices.length < 3) return;

        const positions = [];

        for (let i = 1; i < vertices.length - 1; i++) {
            positions.push(
                vertices[0].x, vertices[0].y,
                vertices[i].x, vertices[i].y,
                vertices[i + 1].x, vertices[i + 1].y
            );
        }

        this._bindAndDraw(new Float32Array(positions), color, this.gl.TRIANGLES);
    }

    setScissor(x, y, width, height) {
        const gl = this.gl;
        const pr = this.pixelRatio;
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(
            Math.round(x * pr),
            Math.round((this.vexel.height - y - height) * pr),
            Math.round(width * pr),
            Math.round(height * pr)
        );
    }

    clearScissor() {
        const gl = this.gl;
        gl.disable(gl.SCISSOR_TEST);
    }

    createTexture(image) {
        const gl = this.gl;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return texture;
    }

    getStats() {
        return {
            drawCalls: this.drawCalls,
            initialized: this.initialized,
            renderer: 'WebGL',
            maxTextureSize: this.maxTextureSize
        };
    }

    destroy() {
        this._cleanupGL();
    }
}

if (typeof window !== 'undefined') {
    window.VexelWebGLRenderer = VexelWebGLRenderer;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VexelWebGLRenderer;
}
