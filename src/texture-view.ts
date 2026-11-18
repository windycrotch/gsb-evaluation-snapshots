import {
    Layer,
    LayerComposition,
    Entity,
    Mesh,
    ShaderMaterial,
    MeshInstance,
    Color,
    Texture,
    FILTER_LINEAR,
    FILTER_NEAREST,
    FILTER_LINEAR_MIPMAP_LINEAR,
    FILTER_NEAREST_MIPMAP_LINEAR,
    PIXELFORMAT_R8_G8_B8_A8,
    TEXTURETYPE_DEFAULT,
    SEMANTIC_POSITION,
    ShaderChunks,
    SHADERLANGUAGE_GLSL
} from 'playcanvas';

import type { RenderCanvas } from './render-canvas';
import type { TextureDoc } from './texture-doc';
import { TextureViewState } from './texture-view-state';

class TextureView {
    canvas: RenderCanvas;
    composition: LayerComposition;
    layer: Layer;
    root: Entity;
    material: ShaderMaterial;
    render: Entity;
    meshInstance: MeshInstance;
    camera: Entity;
    defaultTex: Texture;
    rebuildMaterial: boolean;
    texture: TextureDoc | null;
    textureType: string;
    alpha: boolean;
    filter: boolean;
    mipmap: number;
    exposure: number;
    state: TextureViewState;

    constructor(canvas: RenderCanvas) {
        const device = canvas.renderer.app.graphicsDevice;

        this.canvas = canvas;

        // construct the scene
        this.composition = new LayerComposition('texture-preview');

        this.layer = new Layer({
            id: -2,
            enabled: true,
            opaqueSortMode: 2,
            transparentSortMode: 3
        });
        this.composition.push(this.layer);

        this.canvas.composition = this.composition;

        // root entity
        this.root = new Entity();

        // mesh
        const mesh = new Mesh(device);
        mesh.setPositions([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
        mesh.setIndices([0, 1, 2, 0, 2, 3]);
        mesh.update();

        // construct the material
        this.material = new ShaderMaterial();

        // render entity
        this.meshInstance = new MeshInstance(mesh, this.material);
        this.render = new Entity();
        this.render.addComponent('render', {
            material: this.material,
            meshInstances: [this.meshInstance]
        });
        this.root.addChild(this.render);

        // camera
        this.camera = new Entity();
        this.camera.addComponent('camera', {
            nearClip: 0.01,
            farClip: 32,
            fov: 30,
            clearColor: new Color(0, 0, 0, 0),
            frustumCulling: false,
            layers: []
        });
        this.camera.setLocalPosition(0, 0, 2.2);
        this.camera.camera!.layers = [this.layer.id];
        this.root.addChild(this.camera);

        this.layer.addMeshInstances(this.render.render!.meshInstances);
        this.layer.addCamera(this.camera.camera!);

        this.root.syncHierarchy();

        // handle canvas resize
        this.canvas.on('resize', () => {
            this.setViewport(
                this.canvas.canvasWidth * window.devicePixelRatio,
                this.canvas.canvasHeight * window.devicePixelRatio
            );
        });

        // handle renders
        this.canvas.on('prerender', () => {
            // set filtering
            if (this.texture && this.texture.resource) {
                this.texture.resource.magFilter = this.filter ? FILTER_LINEAR : FILTER_NEAREST;
                this.texture.resource.minFilter = this.filter
                    ? FILTER_LINEAR_MIPMAP_LINEAR
                    : FILTER_NEAREST_MIPMAP_LINEAR;
            }
            this.prepare();
        });

        // create default texture
        const data = new Uint8Array([64, 64, 64, 255]);
        this.defaultTex = new Texture(device, {
            cubemap: false,
            width: 1,
            height: 1,
            format: PIXELFORMAT_R8_G8_B8_A8,
            type: TEXTURETYPE_DEFAULT,
            levels: [data]
        });

        this.rebuildMaterial = true;
        this.texture = null;
        this.meshInstance.visible = false;
        this.textureType = 'gamma';
        this.alpha = false;
        this.filter = false;
        this.mipmap = 0;
        this.exposure = 1;
        this.state = new TextureViewState();
        this.state.setPixelRatio(window.devicePixelRatio);
        this.state.setViewport(300, 150);
    }

    setTexture(texture: TextureDoc): void {
        if (texture !== this.texture) {
            this.texture = texture;
            this.meshInstance.visible = !!texture.resource;
            this.state.setTexture(
                texture.resource ? texture.width : null,
                texture.resource ? texture.height : null,
                !!texture.cubemap
            );
            this.rebuildMaterial = true;
            this.canvas.render();
        }
    }

    /**
     * Request a redraw after the view transform was changed directly on {@link TextureView#state}.
     */
    requestRender(): void {
        this.canvas.render();
    }

    setFace(value: number): void {
        if (this.state.setFace(value)) {
            this.canvas.render();
        }
    }

    setTextureType(value: string): void {
        if (value !== this.textureType) {
            this.textureType = value;
            this.rebuildMaterial = true;
            this.canvas.render();
        }
    }

    setAlpha(value: boolean): void {
        if (value !== this.alpha) {
            this.alpha = value;
            this.rebuildMaterial = true;
            this.canvas.render();
        }
    }

    setFilter(value: boolean): void {
        if (value !== this.filter) {
            this.filter = value;
            this.canvas.render();
        }
    }

    setMipmap(value: number): void {
        if (value !== this.mipmap) {
            this.mipmap = value;
            this.canvas.render();
        }
    }

    setExposure(value: number): void {
        if (value !== this.exposure) {
            this.exposure = value;
            this.canvas.render();
        }
    }

    setViewport(width: number, height: number): void {
        this.state.setPixelRatio(window.devicePixelRatio);
        this.state.setViewport(width, height);
        this.canvas.render();
    }

    // Build the fragment shader source with current settings.
    // Original shader logic from src/chunks/texture.frag.js, adapted for ShaderMaterial API.
    buildFragmentShader(): string {
        const decodeFunc: Record<string, string> = {
            gamma: 'decodeGamma',
            linear: 'decodeLinear',
            rgbm: 'decodeRGBM',
            rgbe: 'decodeRGBE',
            rgbp: 'decodeRGBP',
            a: 'decodeAlpha'
        };

        const isCubemap = this.texture && this.texture.cubemap;
        const decodeFuncName = decodeFunc[this.textureType];

        // Get decode functions from engine, add custom decodeAlpha
        const device = this.canvas.renderer.app.graphicsDevice;
        const chunks = ShaderChunks.get(device, SHADERLANGUAGE_GLSL);
        const decodeFunctions = `
${chunks.get('decodePS')}
vec3 decodeAlpha(vec4 raw) {
    return vec3(raw.a);
}
`;

        return `
${decodeFunctions}

uniform float mipmap;
uniform float exposure;
uniform vec2 offset;
uniform float scale;
uniform vec2 viewportSize;
uniform vec2 texSize;

${isCubemap ? 'uniform samplerCube tex;' : 'uniform sampler2D tex;'}
${isCubemap ? 'uniform float face;' : ''}

${
    isCubemap
        ? `
vec3 getCubemapUv(vec2 uv, float face) {
    vec2 st = uv * 2.0 - 1.0;
    if (face == 0.0) {
        return vec3(1, -st.y, -st.x);
    } else if (face == 1.0) {
        return vec3(-1, -st.y, st.x);
    } else if (face == 2.0) {
        return vec3(st.x, 1, st.y);
    } else if (face == 3.0) {
        return vec3(st.x, -1, -st.y);
    } else if (face == 4.0) {
        return vec3(st.x, -st.y, 1);
    } else {
        return vec3(-st.x, -st.y, -1);
    }
}
`
        : ''
}

vec3 encodeGamma(vec3 source) {
    return pow(source, vec3(1.0 / 2.2));
}

float tile(vec2 coord, float tileSize) {
    return mod(dot(floor(coord * 2.0 / tileSize), vec2(1.0)), 2.0);
}

void main() {
    vec2 uv = (gl_FragCoord.xy - offset) / scale / texSize;

    ${
        isCubemap
            ? 'vec4 raw = textureCubeLod(tex, getCubemapUv(vec2(uv.x, 1.0 - uv.y), face), mipmap);'
            : 'vec4 raw = textureLod(tex, vec2(uv.x, 1.0 - uv.y), mipmap);'
    }

    vec3 final = ${decodeFuncName}(raw);
    float alpha = raw.a;

    final *= exposure;

    ${
        this.alpha
            ? `
    vec3 tileClr = mix(vec3(0.3), vec3(0.5), tile(gl_FragCoord.xy, 50.0));
    final = mix(tileClr, final, alpha);
    `
            : ''
    }

    float oob = any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0))) ? 0.0 : 1.0;
    final = mix(vec3(0.15), final, oob);

    gl_FragColor = vec4(encodeGamma(final), 1.0);
}
`;
    }

    // prepare the material for rendering
    prepare(): void {
        if (this.rebuildMaterial) {
            this.rebuildMaterial = false;

            const isCubemap = this.texture && this.texture.cubemap;
            const uniqueName = `texture-view-${this.textureType}-${this.alpha ? 'alpha' : 'noalpha'}-${isCubemap ? 'cube' : '2d'}`;

            this.material.shaderDesc = {
                uniqueName: uniqueName,
                attributes: { vertex_position: SEMANTIC_POSITION },
                vertexGLSL: `
attribute vec3 vertex_position;

void main() {
    gl_Position = vec4(vertex_position * 2.0 - 1.0, 1.0);
}
`,
                fragmentGLSL: this.buildFragmentShader()
            };
        }
        this.material.setParameter('tex', this.texture?.resource || this.defaultTex);
        this.material.setParameter('face', this.state.face);
        this.material.setParameter('mipmap', this.mipmap);
        this.material.setParameter('exposure', this.exposure);
        this.material.setParameter('offset', [this.state.offsetX, this.state.offsetY]);
        this.material.setParameter('scale', this.state.scale);
        this.material.setParameter('viewportSize', [this.state.viewportW, this.state.viewportH]);
        this.material.setParameter(
            'texSize',
            this.texture ? [this.texture.width ?? 1, this.texture.height ?? 1] : [1, 1]
        );
        this.material.update();
    }
}

export { TextureView };
