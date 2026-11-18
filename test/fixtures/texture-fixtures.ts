import type { Asset, Texture } from 'playcanvas';

import { TextureDoc } from '../../src/texture-doc.ts';

type SampleLevel = {
    data: Uint8Array;
    width: number;
    height: number;
};

export type SampleTexture = {
    doc: TextureDoc;
    width: number;
    height: number;
    cubemap: boolean;
    levels: SampleLevel[];
};

// return a distinct, fully opaque colour for every texel of the fixture so that a test can tell
// exactly which texel it sampled
const texelColor = (x: number, y: number): [number, number, number, number] => [
    (x * 37 + y * 11) & 0xff,
    (x * 13 + y * 53) & 0xff,
    (x * 7 + y * 97) & 0xff,
    255
];

const buildLevel = (width: number, height: number): SampleLevel => {
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; ++y) {
        for (let x = 0; x < width; ++x) {
            const [r, g, b, a] = texelColor(x, y);
            const i = (y * width + x) * 4;
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = a;
        }
    }
    return { data, width, height };
};

const buildMipChain = (width: number, height: number, mipmaps: boolean): SampleLevel[] => {
    const levels: SampleLevel[] = [buildLevel(width, height)];
    if (!mipmaps) {
        return levels;
    }
    let w = width;
    let h = height;
    while (w > 1 || h > 1) {
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
        levels.push(buildLevel(w, h));
    }
    return levels;
};

/**
 * Build a self-contained `TextureDoc` for a locally generated 2D texture. The document is backed
 * by a plain object standing in for the loaded `Asset`, so no GPU or network access is required.
 *
 * @param width - Texture width in texels.
 * @param height - Texture height in texels.
 * @param options - Optional fixture settings.
 * @param options.mipmaps - Generate a full mip chain (default false).
 * @param options.encoding - Texture encoding exposed to the preview (default 'gamma').
 * @returns The texture document and its fixture metadata.
 */
export const create2DTexture = (
    width: number,
    height: number,
    options: { mipmaps?: boolean; encoding?: string } = {}
): SampleTexture => {
    const levels = buildMipChain(width, height, !!options.mipmaps);

    const resource = {
        width,
        height,
        cubemap: false,
        mipmaps: levels.length > 1,
        encoding: options.encoding ?? 'gamma',
        type: 1,
        format: 7,
        _levels: levels,
        face: 0
    } as unknown as Texture;

    const asset = {
        id: 1,
        file: { filename: `sample-2d-${width}x${height}.png`, url: `sample-2d-${width}x${height}.png` },
        resource
    } as unknown as Asset;

    return {
        doc: new TextureDoc(asset),
        width,
        height,
        cubemap: false,
        levels
    };
};

/**
 * Build a self-contained `TextureDoc` for a locally generated cubemap. Every face shares the same
 * generated data; only the face index differentiates them.
 *
 * @param size - Edge length of each cubemap face in texels.
 * @param options - Optional fixture settings.
 * @param options.encoding - Texture encoding exposed to the preview (default 'gamma').
 * @returns The texture document and its fixture metadata.
 */
export const createCubemap = (size: number, options: { encoding?: string } = {}): SampleTexture => {
    const level = buildLevel(size, size);

    const resource = {
        width: size,
        height: size,
        cubemap: true,
        mipmaps: false,
        encoding: options.encoding ?? 'gamma',
        type: 1,
        format: 7,
        _levels: [level],
        face: 0
    } as unknown as Texture;

    const asset = {
        id: 2,
        file: { filename: `sample-cube-${size}.png`, url: `sample-cube-${size}.png` },
        resource
    } as unknown as Asset;

    return {
        doc: new TextureDoc(asset),
        width: size,
        height: size,
        cubemap: true,
        levels: [level]
    };
};
