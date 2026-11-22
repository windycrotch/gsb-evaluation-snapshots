# DXF load consistency: encoding, layer visibility and entity colors

How `DxfLoader` keeps three easily-conflicting paths consistent and explainable, and how to verify it.

## Text encoding

`decodeDxfText(bytes, dxfEncoding?, warnings?)` decides in this order:

1. Explicit `dxfEncoding` option (highest priority; a U+FFFD-producing decode still warns).
2. BOM (UTF-8 / UTF-16LE / UTF-16BE).
3. Valid UTF-8 bytes + (declared UTF-8 codepage or AC1021 and newer) → UTF-8.
4. The `$DWGCODEPAGE` declared in the header.
5. With no declaration, the best-scoring legacy candidate among `windows-1252 / gb18030 / big5 / shift_jis / euc-kr / iso-8859-1` (replacement characters, control characters, CJK coverage, DXF structure).

**Fallback when the declaration lies**: if the declared codepage decodes with U+FFFD replacement characters, the declaration does not match the bytes. The loader then tries valid UTF-8, then the best-scoring legacy candidate (only if it has fewer replacements and no control characters). When nothing decodes reliably, it keeps the declared decode and appends a readable warning to `document.warnings` naming the codepage and replacement count — never silent mojibake. Every candidate encoding is ASCII-compatible, so group codes and section structure stay parseable on every path.

## Layer visibility

- The layer table is built from `dxf-parser` plus a bounded metadata pass (`DxfBomSupplement`); both honor the raw group 62 sign: a negative color number means `isVisible: false` with the absolute ACI kept as the color.
- A turned-off layer **stays in** `document.layers` (color, linetype, lineweight, frozen/locked flags included); only `layerVisible(layer)` returns `false`.
- Renderers (Canvas2D and WebGL) skip entities on invisible layers entirely instead of drawing them with normal colors; the entity data (colors, true color, geometry) remains intact in the document.

## Entity color priority

`resolveCadColor` keeps the existing priority: explicit CSS color → true color (group 420) → ACI index (group 62) → numeric `color` → layer color.

`dxf-parser` rewrites both group 62 (ACI) and group 420 (true color) into a single ambiguous numeric `color` property. The metadata pass therefore re-reads the raw 62/420 groups — matched by handle, or by section+type+ordinal for handle-less R12 files — and corrects the normalized entities:

- Source record has 420 → `entity.trueColor` follows the source (true color beats ACI and is never lost because its layer is off);
- Source record has no 420 → the derived pseudo-`trueColor` is removed, restoring ACI semantics (notably ACI 7's foreground-dependent rendering).

The built-in fallback parser only reads real 420 groups, so both parse paths produce identical colors.

## Load isolation

`DxfLoader` keeps no cross-load state: encoding decisions, the layer table and entity normalization are all derived from the current input bytes. Repeated loads of the same bytes, concurrent loads of differently encoded files, and retries after a failure (missing input, or the primary parser throwing into the fallback) all produce identical results. Regression tests lock this in.

## Verification

```bash
npm run build:lib          # builds dist (tests import dist/cad-viewer.es.js)
node --test test/*.test.mjs
```

Key regression files:

- `test/dxf-load-consistency.test.mjs` — encoding fallback and warnings, turned-off layers, true-color priority, primary/fallback parser parity, repeat/concurrent/retry isolation; every DXF sample is constructed inline (`dxfWithText` / `dxfWithLayers`), no external files needed.
- `test/dxf-text-decoding.test.mjs` — existing encoding matrix (BOM, version rule, explicit override, escape sequences).
- `test/dxf-layer-table.test.mjs` — existing layer-table normalization (negative color numbers, freeze/lock, true-color layers).
