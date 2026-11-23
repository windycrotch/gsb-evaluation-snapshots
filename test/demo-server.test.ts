import './setup';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SplatModel, ModelStatus } from '../src/reall3d/modeldata/ModelData';
import { loadSplat } from '../src/reall3d/modeldata/loaders/SplatLoader';
import { loadPly } from '../src/reall3d/modeldata/loaders/PlyLoader';
import { buildSplatFile, buildPlyFile, DemoFetchServer } from '../demo/loader-lifecycle-data';

const URL = 'demo://model';

test('demo server + real loaders: splat normal and limit-stop flows', async () => {
    const server = new DemoFetchServer();
    server.install();
    try {
        server.register(URL, buildSplatFile(50), 64);
        const full = new SplatModel({ url: URL, format: 'splat' });
        full.fetchLimit = 50;
        await loadSplat(full);
        assert.equal(full.status, ModelStatus.FetchDone);
        assert.equal(full.dataSplatCount, 50);
        assert.equal(full.maxX, 49);

        server.register(URL, buildSplatFile(50), 64);
        const limited = new SplatModel({ url: URL, format: 'splat' });
        limited.fetchLimit = 12;
        await loadSplat(limited);
        assert.equal(limited.status, ModelStatus.FetchDone);
        assert.equal(limited.fetchLimitReached, true);
        assert.equal(limited.dataSplatCount, 12);
        assert.equal(limited.maxX, 11);
    } finally {
        server.restore();
    }
});

test('demo server: failure then clean retry', async () => {
    const server = new DemoFetchServer();
    server.install();
    try {
        server.register(URL, buildPlyFile(30), 136, 500);
        const model = new SplatModel({ url: URL, format: 'ply' });
        model.fetchLimit = 30;
        await loadPly(model);
        assert.equal(model.status, ModelStatus.FetchFailed);

        server.register(URL, buildPlyFile(30), 136);
        await loadPly(model);
        assert.equal(model.status, ModelStatus.FetchDone);
        assert.equal(model.dataSplatCount, 30);
        assert.equal(model.maxZ, 29 * 100);
    } finally {
        server.restore();
    }
});
