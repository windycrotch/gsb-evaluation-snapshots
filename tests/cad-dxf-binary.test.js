import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDocument } from '../src/cad/document.js';
import { parseDxf, writeDxf } from '../src/cad/dxf.js';
import { binaryDxfToText, isBinaryDxf, readDxfFile } from '../src/cad/dxf-binary.js';

const SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\0';
const latin1 = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const utf8 = (text) => new TextEncoder().encode(text);

// TextDecoder legado existe, mas não há TextEncoder correspondente: monta o mapa
// reverso byte -> caractere varrendo a própria tabela da codificação.
function legacyEncoder(label) {
    const reverse = new Map();
    const decoder = new TextDecoder(label);
    for (let byte = 0x80; byte <= 0xff; byte += 1) {
        const char = decoder.decode(Uint8Array.of(byte));
        if (char && char.codePointAt(0) > 0x7f && char !== '�') reverse.set(char, [byte]);
    }
    for (let high = 0x81; high <= 0xfe; high += 1) {
        for (let low = 0x40; low <= 0xfe; low += 1) {
            if (low === 0x7f) continue;
            const char = decoder.decode(Uint8Array.of(high, low));
            if (char && char.codePointAt(0) > 0x7f && char !== '�' && !reverse.has(char)) {
                reverse.set(char, [high, low]);
            }
        }
    }
    return (text) => {
        const bytes = [];
        for (const char of text) {
            const code = char.codePointAt(0);
            if (code < 0x80) bytes.push(code);
            else {
                const mapped = reverse.get(char);
                assert.ok(mapped, `caractere ${char} inexistente em ${label}`);
                bytes.push(...mapped);
            }
        }
        return Uint8Array.from(bytes);
    };
}
const shiftJis = legacyEncoder('shift_jis');
const big5 = legacyEncoder('big5');
const gbk = legacyEncoder('gbk');
const cp1252 = legacyEncoder('windows-1252');

function typedValue(code, value) {
    const number = (size, write) => {
        const view = new DataView(new ArrayBuffer(size));
        write(view);
        return new Uint8Array(view.buffer);
    };
    if ((code >= 10 && code <= 59) || (code >= 110 && code <= 149) || (code >= 210 && code <= 239) || (code >= 1010 && code <= 1059)) {
        return number(8, (v) => v.setFloat64(0, Number(value), true));
    }
    if (code === 1071 || (code >= 90 && code <= 99) || (code >= 420 && code <= 429) || (code >= 440 && code <= 459)) {
        return number(4, (v) => v.setInt32(0, Number(value), true));
    }
    if ((code >= 60 && code <= 79) || (code >= 170 && code <= 179) || (code >= 270 && code <= 289) || (code >= 370 && code <= 389)) {
        return number(2, (v) => v.setInt16(0, Number(value), true));
    }
    return null;
}

// Codifica pares código/valor no formato binário, com códigos de 2 bytes (R13+) ou 1 byte (R12).
function encode(pairs, { wideCodes = true, encodeText = utf8 } = {}) {
    const parts = [latin1(SENTINEL)];
    for (const [code, value] of pairs) {
        if (wideCodes) parts.push(new Uint8Array(new Int16Array([code]).buffer));
        else if (code < 255) parts.push(Uint8Array.of(code));
        else parts.push(Uint8Array.of(255), new Uint8Array(new Int16Array([code]).buffer));
        if (code >= 290 && code <= 299) parts.push(Uint8Array.of(Number(value)));
        else if ((code >= 310 && code <= 319) || code === 1004) parts.push(Uint8Array.of(value.length), Uint8Array.from(value));
        else if (code >= 160 && code <= 169) parts.push(new Uint8Array(new BigInt64Array([BigInt(value)]).buffer));
        else parts.push(typedValue(code, value) ?? Uint8Array.of(...encodeText(String(value)), 0));
    }
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function pairsOf(text) {
    const lines = text.split(/\r?\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([Number(lines[i].trim()), lines[i + 1].trim()]);
    return pairs;
}

const drawing = () => writeDxf({
    ...createDocument(),
    entities: [
        { id: '1', type: 'line', start: { x: 0, y: 0 }, end: { x: 100.5, y: 25.25 } },
        { id: '2', type: 'circle', center: { x: 10, y: 20 }, radius: 7.125 },
        { id: '3', type: 'arc', center: { x: 40, y: 0 }, radius: 5, start: 0, end: 90 },
        { id: '4', type: 'polyline', closed: true, vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
        { id: '5', type: 'text', text: 'Peça', position: { x: 1, y: 2 }, height: 3 },
    ],
});
const shape = (parsed) => parsed.entities.map(({ id, ...entity }) => entity);

test('DXF binário R13+ abre igual ao mesmo desenho em ASCII', () => {
    const ascii = drawing();
    const bytes = encode(pairsOf(ascii));
    assert.equal(isBinaryDxf(bytes), true);
    const parsed = parseDxf(binaryDxfToText(bytes));
    assert.equal(parsed.entities.length, 5);
    assert.deepEqual(shape(parsed), shape(parseDxf(ascii)));
});

test('DXF binário R12 usa código de 1 byte, com 255 como escape', () => {
    const text = binaryDxfToText(encode([[0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [8, '0'], [10, 1.5], [20, 2], [11, 3], [21, 4], [1000, 'x'], [0, 'ENDSEC'], [0, 'EOF']], { wideCodes: false }));
    assert.match(text, /^0\nSECTION\n2\nENTITIES\n/);
    assert.match(text, /\n1000\nx\n/);
    const parsed = parseDxf(text);
    assert.deepEqual(parsed.entities[0].start, { x: 1.5, y: 2 });
    assert.deepEqual(parsed.entities[0].end, { x: 3, y: 4 });
});

test('todos os tipos de valor mantêm os pares alinhados, inclusive objeto embutido e blocos de bytes', () => {
    const text = binaryDxfToText(encode([
        [0, 'SECTION'], [2, 'OBJECTS'], [290, 1], [160, '5000000000'], [310, [0xab, 0x01]], [1004, [0xff]], [101, 'Embedded Object'],
        [1071, 7], [420, -2], [70, -3], [330, '1F'], [0, 'ENDSEC'], [0, 'EOF'],
    ]));
    assert.deepEqual(pairsOf(text), [
        [0, 'SECTION'], [2, 'OBJECTS'], [290, '1'], [160, '5000000000'], [310, 'AB01'], [1004, 'FF'], [101, 'Embedded Object'],
        [1071, '7'], [420, '-2'], [70, '-3'], [330, '1F'], [0, 'ENDSEC'], [0, 'EOF'],
    ]);
});

test('textos seguem $DWGCODEPAGE até o R2004 e UTF-8 a partir do AC1021', () => {
    const body = (version) => [[0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, version], [9, '$DWGCODEPAGE'], [3, 'ANSI_1252'], [0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [1, 'Peça'], [0, 'ENDSEC'], [0, 'EOF']];
    assert.match(binaryDxfToText(encode(body('AC1032'))), /\nPeça\n/);
    assert.match(binaryDxfToText(encode(body('AC1018'), { encodeText: latin1 })), /\nPeça\n/);
});

test('quebra de linha dentro de um valor não desalinha os pares', () => {
    const text = binaryDxfToText(encode([[0, 'TEXT'], [1, 'a\r\nb'], [0, 'EOF']]));
    assert.deepEqual(pairsOf(text), [[0, 'TEXT'], [1, 'a b'], [0, 'EOF']]);
});

test('ignora o que vem depois do EOF', () => {
    const bytes = encode([[0, 'EOF']]);
    const padded = new Uint8Array(bytes.length + 8).fill(0x7f);
    padded.set(bytes);
    assert.equal(binaryDxfToText(padded), '0\nEOF\n');
});

test('arquivo truncado e código desconhecido falham com mensagem, sem abrir desenho pela metade', () => {
    const bytes = encode([[0, 'SECTION'], [10, 1.5]]);
    assert.throws(() => binaryDxfToText(bytes.subarray(0, bytes.length - 3)), /truncado/);
    assert.throws(() => binaryDxfToText(encode([[0, 'SECTION'], [2000, 'x']])), /Código de grupo 2000/);
});

test('readDxfFile aceita os dois formatos a partir do File', async () => {
    const ascii = drawing();
    assert.equal(isBinaryDxf(utf8(ascii)), false);
    assert.equal(await readDxfFile(new File([ascii], 'a.dxf')), ascii);
    const text = await readDxfFile(new File([encode(pairsOf(ascii))], 'b.dxf'));
    assert.equal(parseDxf(text).entities.length, 5);
});

// Monta um DXF binário mínimo com HEADER (versão e/ou código de página, em qualquer ordem)
// e um único TEXT cujo valor é o texto não ASCII a preservar na tradução.
function headerDxf({ version = null, codePage = null, order = ['version', 'codePage'], text, encodeText = utf8 }) {
    const header = [];
    const pushVersion = () => version != null && header.push([9, '$ACADVER'], [1, version]);
    const pushCodePage = () => codePage != null && header.push([9, '$DWGCODEPAGE'], [3, codePage]);
    for (const key of order) (key === 'version' ? pushVersion : pushCodePage)();
    return encode([
        [0, 'SECTION'], [2, 'HEADER'], ...header, [0, 'ENDSEC'],
        [0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [1, text], [0, 'ENDSEC'], [0, 'EOF'],
    ], { encodeText });
}

function valueOfGroup(textOutput, groupCode) {
    const pairs = pairsOf(textOutput);
    // O valor do $ACADVER também usa o grupo 1; o texto da entidade TEXT é o último par do grupo.
    return pairs.findLast(([code]) => code === groupCode)?.[1];
}

const JP = '日本語テスト';
const ZH_TW = '繁體中文測試';
const ZH_CN = '简体中文测试';
const PT = 'Peça de medição ×4 — açúcar 90°';

test('UTF-8 (AC1032) vence mesmo com $DWGCODEPAGE ANSI_932 depois do $ACADVER', () => {
    const text = binaryDxfToText(headerDxf({ version: 'AC1032', codePage: 'ANSI_932', order: ['version', 'codePage'], text: JP }));
    assert.equal(valueOfGroup(text, 1), JP);
});

test('$DWGCODEPAGE antes do $ACADVER: o UTF-8 que chega depois substitui o shift_jis', () => {
    const text = binaryDxfToText(headerDxf({ version: 'AC1032', codePage: 'ANSI_932', order: ['codePage', 'version'], text: JP }));
    assert.equal(valueOfGroup(text, 1), JP);
});

test('apenas $DWGCODEPAGE: textos em shift_jis e big5 são traduzidos corretamente', () => {
    const japanese = binaryDxfToText(headerDxf({ codePage: 'ANSI_932', order: ['codePage'], text: JP, encodeText: shiftJis }));
    assert.equal(valueOfGroup(japanese, 1), JP);
    const traditional = binaryDxfToText(headerDxf({ codePage: 'ANSI_950', order: ['codePage'], text: ZH_TW, encodeText: big5 }));
    assert.equal(valueOfGroup(traditional, 1), ZH_TW);
});

test('apenas $ACADVER >= AC1021: textos UTF-8 são traduzidos sem $DWGCODEPAGE', () => {
    const text = binaryDxfToText(headerDxf({ version: 'AC1021', order: ['version'], text: ZH_CN }));
    assert.equal(valueOfGroup(text, 1), ZH_CN);
});

test('versão antiga com código de página: ANSI_936 (gbk) e ANSI_1252 governam os textos', () => {
    const simplified = binaryDxfToText(headerDxf({
        version: 'AC1018', codePage: 'ANSI_936', order: ['version', 'codePage'], text: ZH_CN, encodeText: gbk,
    }));
    assert.equal(valueOfGroup(simplified, 1), ZH_CN);
    const portuguese = binaryDxfToText(headerDxf({
        version: 'AC1015', codePage: 'ANSI_1252', order: ['codePage', 'version'], text: PT, encodeText: cp1252,
    }));
    assert.equal(valueOfGroup(portuguese, 1), PT);
});

test('combinação contraditória: versão antiga + página asiática não vira UTF-8, e a página vence', () => {
    const text = binaryDxfToText(headerDxf({
        version: 'AC1014', codePage: 'ANSI_932', order: ['version', 'codePage'], text: JP, encodeText: shiftJis,
    }));
    assert.equal(valueOfGroup(text, 1), JP);
});

test('código de página desconhecido ou mal formado cai em windows-1252 sem lançar erro', () => {
    const unknown = binaryDxfToText(headerDxf({
        version: 'AC1018', codePage: 'ANSI_9999', order: ['codePage', 'version'], text: PT, encodeText: cp1252,
    }));
    assert.equal(valueOfGroup(unknown, 1), PT);
    const garbage = binaryDxfToText(headerDxf({
        codePage: 'LATIN-1 (não padrão)', order: ['codePage'], text: PT, encodeText: cp1252,
    }));
    assert.equal(valueOfGroup(garbage, 1), PT);
    // Já em UTF-8, o $DWGCODEPAGE desconhecido que vem depois também não troca o decodificador.
    const unicode = binaryDxfToText(headerDxf({
        version: 'AC1032', codePage: 'ANSI_9999', order: ['version', 'codePage'], text: JP,
    }));
    assert.equal(valueOfGroup(unicode, 1), JP);
});

test('quebra de linha em texto não ASCII também vira espaço e mantém os pares alinhados', () => {
    const text = binaryDxfToText(headerDxf({ version: 'AC1032', order: ['version'], text: `linha 1\n${JP}\r\nfim` }));
    assert.ok(text.includes(`\n1\nlinha 1 ${JP} fim\n`));
    assert.equal(pairsOf(text).find(([code, value]) => code === 1 && value.includes('linha 1'))[1], `linha 1 ${JP} fim`);
});

test('erros de arquivo truncado e grupo desconhecido trazem o byte exato da falha', () => {
    const truncated = headerDxf({ version: 'AC1032', order: ['version'], text: JP });
    assert.throws(
        () => binaryDxfToText(truncated.subarray(0, truncated.length - 4)),
        (error) => {
            assert.match(error.message, /DXF binário truncado no byte \d+\./);
            const offset = Number(/byte (\d+)/.exec(error.message)[1]);
            assert.ok(offset >= SENTINEL.length && offset < truncated.length);
            return true;
        },
    );
    const badGroup = encode([[0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1032'], [0, 'ENDSEC'], [2000, 'x'], [0, 'EOF']]);
    assert.throws(
        () => binaryDxfToText(badGroup),
        (error) => {
            assert.match(error.message, /Código de grupo 2000 desconhecido no byte \d+ do DXF binário\./);
            // O par 2000/"x" é seguido pelo par 0/EOF: 2 bytes do código + 2 do valor ("x\0")
            // e mais 2 do código + 4 do valor ("EOF\0") depois do início do código 2000.
            const expectedOffset = badGroup.length - (4 + 6);
            assert.ok(error.message.includes(`byte ${expectedOffset}`));
            return true;
        },
    );
});
