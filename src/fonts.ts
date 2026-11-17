import cyr400 from '@fontsource/inter/files/inter-cyrillic-400-normal.woff2?url';
import cyr600 from '@fontsource/inter/files/inter-cyrillic-600-normal.woff2?url';
import lat400 from '@fontsource/inter/files/inter-latin-400-normal.woff2?url';
import lat600 from '@fontsource/inter/files/inter-latin-600-normal.woff2?url';

/** Font family used by the renderer (see DEFAULT_FONT). */
export const FONT_FAMILY = 'Inter';

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const CYRILLIC = 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116';

let loading: Promise<void> | null = null;

/**
 * Loads Inter (Latin + Cyrillic) from our own static files. Canvas doesn't wait for fonts —
 * without this, the first frames would be drawn with a system font.
 */
export function loadFonts(): Promise<void> {
  loading ??= (async () => {
    const faces = [
      new FontFace(FONT_FAMILY, `url(${lat400})`, { weight: '400', unicodeRange: LATIN }),
      new FontFace(FONT_FAMILY, `url(${cyr400})`, { weight: '400', unicodeRange: CYRILLIC }),
      new FontFace(FONT_FAMILY, `url(${lat600})`, { weight: '600', unicodeRange: LATIN }),
      new FontFace(FONT_FAMILY, `url(${cyr600})`, { weight: '600', unicodeRange: CYRILLIC }),
    ];
    await Promise.all(faces.map((f) => f.load()));
    for (const f of faces) document.fonts.add(f);
  })().catch((err) => {
    loading = null; // on failure, fall back to the system font and retry next time
    console.warn('Font loading failed', err);
  });
  return loading;
}
