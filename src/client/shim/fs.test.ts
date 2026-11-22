// The fs shim's mod layer: swapping it (a mod reload) must drop cached resolved bytes and cached directory
// listings, so a disabled mod's files and replacements disappear instead of going stale.
import { describe, expect, test } from 'bun:test';
import { fs, setModLayer } from './fs.ts';

// The game server is not running here: directory listings come back empty, every file 404s.
class FakeXHR {
    status = 0;
    responseText = '';
    private url = '';
    open(_method: string, url: string) { this.url = url; }
    overrideMimeType() {}
    send() {
        if (this.url.startsWith('/__ls')) { this.status = 200; this.responseText = '[]'; }
        else this.status = 404;
    }
}
(globalThis as any).XMLHttpRequest = FakeXHR;

describe('fs mod layer swap', () => {
    test('a removed mod’s added files and resolved bytes are gone after setModLayer', () => {
        setModLayer({
            has: k => k === 'data/x.txt',
            resolve: () => new TextEncoder().encode('mod'),
            added: dir => (dir === 'data' ? ['x.txt'] : []),
        });
        expect(fs.readdirSync('data')).toEqual(['x.txt']);
        expect(String(fs.readFileSync('data/x.txt', 'utf8'))).toBe('mod');

        setModLayer(null); // the reload disabled the mod
        expect(fs.readdirSync('data')).toEqual([]); // not the stale ['x.txt']
        expect(() => fs.readFileSync('data/x.txt')).toThrow(/ENOENT/);
    });

    test('a new layer answers instead of the old one’s cached bytes', () => {
        setModLayer({ has: k => k === 'data/y.txt', resolve: () => new TextEncoder().encode('old'), added: () => [] });
        expect(String(fs.readFileSync('data/y.txt', 'utf8'))).toBe('old');
        setModLayer({ has: k => k === 'data/y.txt', resolve: () => new TextEncoder().encode('new'), added: () => [] });
        expect(String(fs.readFileSync('data/y.txt', 'utf8'))).toBe('new');
        setModLayer(null);
    });
});
