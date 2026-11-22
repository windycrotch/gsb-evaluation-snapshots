import assert from 'node:assert/strict';
import test from 'node:test';
import { DxfLoader, layerVisible, resolveCadColor } from '../dist/cad-viewer.es.js';

const ascii = (value) => Buffer.from(value, 'latin1');
const GBK_中文测试 = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
const BIG5_中文 = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]);

/** Builds a DXF with a single TEXT entity whose group-1 value is raw bytes. */
function dxfWithText({ version, codepage, textBytes, tail = '0\nENDSEC\n0\nEOF\n' }) {
  const header = [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', version,
    ...(codepage ? ['9', '$DWGCODEPAGE', '3', codepage] : []),
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'TEXT', '5', 'A1', '8', '0', '10', '0', '20', '0', '40', '2', '1'
  ].join('\n') + '\n';
  return Buffer.concat([ascii(header), textBytes, ascii('\n' + tail)]);
}

/** Builds a DXF with a LAYER table and arbitrary ASCII entity group pairs. */
function dxfWithLayers({ version = 'AC1015', codepage = 'ANSI_1252', layers = [], entities = [], tail = '0\nEOF\n' }) {
  const pairs = [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', version,
    '9', '$DWGCODEPAGE', '3', codepage,
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'LAYER', '70', String(layers.length),
    ...layers.flatMap((layer) => [
      '0', 'LAYER', '2', layer.name, '70', String(layer.flags ?? 0), '62', String(layer.color),
      ...(layer.trueColor !== undefined ? ['420', String(layer.trueColor)] : []),
      '6', 'CONTINUOUS'
    ]),
    '0', 'ENDTAB',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    ...entities.flatMap((entity) => [
      '0', entity.type, '5', entity.handle, '8', entity.layer ?? '0',
      ...(entity.colorIndex !== undefined ? ['62', String(entity.colorIndex)] : []),
      ...(entity.trueColor !== undefined ? ['420', String(entity.trueColor)] : []),
      ...entity.pairs
    ]),
    '0', 'ENDSEC',
    tail
  ];
  return Buffer.from(pairs.join('\n') + '\n', 'latin1');
}

const linePairs = ['10', '0', '20', '0', '11', '10', '21', '10'];
const load = (buffer, options) => new DxfLoader().load({ fileName: 'sample.dxf', buffer }, options);
const encodingWarnings = (warnings) => warnings.filter((w) => /encoding|codepage|DWGCODEPAGE|U\+FFFD/i.test(w));

// ---------------------------------------------------------------------------
// Encoding fallback
// ---------------------------------------------------------------------------

test('declared UTF_8 codepage with GBK bytes recovers via legacy decode and warns', async () => {
  const { document } = await load(dxfWithText({ version: 'AC1015', codepage: 'UTF_8', textBytes: GBK_中文测试 }));
  assert.equal(document.entities[0].text, '中文测试');
  assert.ok(!document.entities[0].text.includes('�'), 'text must not contain replacement characters');
  const warnings = encodingWarnings(document.warnings);
  assert.equal(warnings.length, 1, `expected one encoding warning, got: ${document.warnings.join(' | ')}`);
  assert.match(warnings[0], /UTF_8/);
});

test('stale legacy codepage with UTF-8 bytes recovers via UTF-8 and warns', async () => {
  // AC1015 disables the modern-version UTF-8 rule, so the stale ANSI_932
  // declaration is tried first; it produces U+FFFD on these bytes, and the
  // valid UTF-8 interpretation must win with a readable warning.
  const buffer = dxfWithText({ version: 'AC1015', codepage: 'ANSI_932', textBytes: Buffer.from('日本語', 'utf8') });
  const { document } = await load(buffer);
  assert.equal(document.entities[0].text, '日本語');
  const warnings = encodingWarnings(document.warnings);
  assert.equal(warnings.length, 1, `expected one encoding warning, got: ${document.warnings.join(' | ')}`);
  assert.match(warnings[0], /UTF-8/);
});

test('unreliable encoding keeps a readable warning and a parseable document', async () => {
  const { document } = await load(dxfWithText({ version: 'AC1015', codepage: undefined, textBytes: Buffer.from([0x81]) }));
  assert.equal(document.entities.length, 1, 'DXF structure must still parse');
  const warnings = encodingWarnings(document.warnings);
  assert.ok(warnings.length >= 1, `expected an encoding warning, got: ${document.warnings.join(' | ')}`);
  assert.match(warnings[0], /could not be determined reliably|replacement character/i);
});

test('declared codepage matching the bytes decodes without encoding warnings', async () => {
  const { document } = await load(dxfWithText({ version: 'AC1015', codepage: 'ANSI_936', textBytes: GBK_中文测试 }));
  assert.equal(document.entities[0].text, '中文测试');
  assert.deepEqual(encodingWarnings(document.warnings), []);
});

// ---------------------------------------------------------------------------
// Turned-off layers
// ---------------------------------------------------------------------------

test('a turned-off layer stays in the layer table and keeps its true-colored entity data', async () => {
  const buffer = dxfWithLayers({
    layers: [
      { name: 'ON_LAYER', color: 2 },
      { name: 'OFF_LAYER', color: -5 }
    ],
    entities: [
      { type: 'LINE', handle: '10', layer: 'OFF_LAYER', colorIndex: 1, trueColor: 0x00ff00, pairs: linePairs },
      { type: 'LINE', handle: '11', layer: 'ON_LAYER', pairs: linePairs }
    ]
  });
  const { document } = await load(buffer);

  const off = document.layers.OFF_LAYER;
  assert.ok(off, 'turned-off layer must still appear in the document layer table');
  assert.equal(off.isVisible, false);
  assert.equal(off.colorIndex, 5, 'negative layer color keeps its absolute ACI');
  assert.equal(layerVisible(off), false);
  assert.equal(layerVisible(document.layers.ON_LAYER), true);

  const hidden = document.entities.find((entity) => entity.handle === '10');
  assert.equal(hidden.layer, 'OFF_LAYER');
  assert.equal(hidden.colorIndex, 1);
  assert.equal(hidden.trueColor, 0x00ff00, 'entity true color must survive its layer being off');
  // Color resolution still reports the authored true color; the renderer is
  // responsible for skipping invisible layers via layerVisible().
  assert.equal(resolveCadColor(hidden, document), 'rgb(0, 255, 0)');
});

// ---------------------------------------------------------------------------
// True color vs ACI priority
// ---------------------------------------------------------------------------

test('explicit true color wins over ACI, and ACI-only entities keep ACI semantics', async () => {
  const buffer = dxfWithLayers({
    layers: [{ name: '0', color: 7 }],
    entities: [
      { type: 'LINE', handle: '20', colorIndex: 1, trueColor: 0x0000ff, pairs: linePairs },
      { type: 'LINE', handle: '21', colorIndex: 4, pairs: linePairs },
      { type: 'LINE', handle: '22', colorIndex: 7, pairs: linePairs }
    ]
  });
  const { document } = await load(buffer);
  const byHandle = new Map(document.entities.map((entity) => [entity.handle, entity]));

  assert.equal(byHandle.get('20').trueColor, 0x0000ff);
  assert.equal(byHandle.get('20').colorIndex, 1);
  assert.equal(resolveCadColor(byHandle.get('20'), document), 'rgb(0, 0, 255)', 'true color beats the conflicting ACI');

  assert.equal(byHandle.get('21').trueColor, undefined, 'ACI-only entity must not gain a derived true color');
  assert.equal(resolveCadColor(byHandle.get('21'), document), '#00ffff', 'ACI 4 resolves through the ACI table');

  assert.equal(byHandle.get('22').trueColor, undefined);
  assert.equal(resolveCadColor(byHandle.get('22'), document, { foreground: '#ffffff' }), '#ffffff', 'ACI 7 stays foreground-dependent');
});

test('fallback parser produces the same colors as the primary parser', async () => {
  const entities = [
    { type: 'LINE', handle: '20', colorIndex: 1, trueColor: 0x0000ff, pairs: linePairs },
    { type: 'LINE', handle: '21', colorIndex: 4, pairs: linePairs }
  ];
  const primary = await load(dxfWithLayers({ layers: [{ name: '0', color: 7 }], entities }));
  // A truncated file (no EOF group) makes dxf-parser throw and exercises the
  // built-in fallback parser on the same content.
  const fallback = await load(dxfWithLayers({ layers: [{ name: '0', color: 7 }], entities, tail: '' }));
  assert.ok(fallback.document.warnings.some((w) => /fallback parser/.test(w)), 'fallback path must be taken');

  const colors = (document) => new Map(document.entities.map((entity) => [
    entity.handle,
    { colorIndex: entity.colorIndex, trueColor: entity.trueColor, resolved: resolveCadColor(entity, document) }
  ]));
  assert.deepEqual(colors(fallback.document), colors(primary.document));
});

// ---------------------------------------------------------------------------
// Load isolation: repeat, concurrent, retry
// ---------------------------------------------------------------------------

test('repeated loads of the same bytes give identical results', async () => {
  const buffer = dxfWithText({ version: 'AC1015', codepage: 'ANSI_936', textBytes: GBK_中文测试 });
  const loader = new DxfLoader();
  const first = await loader.load({ fileName: 'a.dxf', buffer });
  const second = await loader.load({ fileName: 'a.dxf', buffer });
  assert.equal(first.document.entities[0].text, '中文测试');
  assert.deepEqual(second.document.entities.map((e) => e.text), first.document.entities.map((e) => e.text));
  assert.deepEqual(second.warnings, first.warnings);
  assert.deepEqual(Object.keys(second.document.layers), Object.keys(first.document.layers));
});

test('concurrent loads of differently encoded files do not pollute each other', async () => {
  const loader = new DxfLoader();
  const gbk = dxfWithText({ version: 'AC1015', codepage: 'ANSI_936', textBytes: GBK_中文测试 });
  const utf8 = dxfWithText({ version: 'AC1032', codepage: 'ANSI_936', textBytes: Buffer.from('助针器上盖', 'utf8') });
  const big5 = dxfWithText({ version: 'AC1015', codepage: 'ANSI_950', textBytes: BIG5_中文 });
  const [gbkResult, utf8Result, big5Result] = await Promise.all([
    loader.load({ fileName: 'gbk.dxf', buffer: gbk }),
    loader.load({ fileName: 'utf8.dxf', buffer: utf8 }),
    loader.load({ fileName: 'big5.dxf', buffer: big5 })
  ]);
  assert.equal(gbkResult.document.entities[0].text, '中文测试');
  assert.equal(utf8Result.document.entities[0].text, '助针器上盖');
  assert.equal(big5Result.document.entities[0].text, '中文');
});

test('a failed load does not poison a retry of the same file', async () => {
  const loader = new DxfLoader();
  await assert.rejects(loader.load({ fileName: 'missing.dxf' }), /requires a File, ArrayBuffer, or Uint8Array/);

  const buffer = dxfWithText({ version: 'AC1015', codepage: 'ANSI_936', textBytes: GBK_中文测试 });
  const retried = await loader.load({ fileName: 'missing.dxf', buffer });
  const fresh = await new DxfLoader().load({ fileName: 'missing.dxf', buffer });
  assert.equal(retried.document.entities[0].text, '中文测试');
  assert.deepEqual(retried.document.entities.map((e) => e.text), fresh.document.entities.map((e) => e.text));
  assert.deepEqual(retried.warnings, fresh.warnings);
});

test('fallback-parser recovery is deterministic across retries', async () => {
  const truncated = dxfWithText({ version: 'AC1015', codepage: 'ANSI_936', textBytes: GBK_中文测试, tail: '' });
  const loader = new DxfLoader();
  const first = await loader.load({ fileName: 'truncated.dxf', buffer: truncated });
  const second = await loader.load({ fileName: 'truncated.dxf', buffer: truncated });
  assert.ok(first.warnings.some((w) => /fallback parser/.test(w)));
  assert.equal(first.document.entities[0].text, '中文测试');
  assert.deepEqual(second.warnings, first.warnings);
  assert.deepEqual(second.document.entities.map((e) => e.text), first.document.entities.map((e) => e.text));
});
