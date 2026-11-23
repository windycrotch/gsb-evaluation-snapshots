import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SplatModel, ModelStatus } from '../src/reall3d/modeldata/ModelData';
import { loadPly } from '../src/reall3d/modeldata/loaders/PlyLoader';
import { buildPlyFile, chunkBytes, installFetchMock, MockServer } from './mockFetch';

const URL = 'test://model.ply';
const TOTAL = 25;

function makeModel(fetchLimit: number): SplatModel {
    const model = new SplatModel({ url: URL, format: 'ply' });
    model.fetchLimit = fetchLimit;
    return model;
}

function registerServer(servers: Map<string, MockServer>, chunkSize: number, failStatus?: number): MockServer {
    const server: any = {
        url: URL,
        chunks: failStatus ? [] : chunkBytes(buildPlyFile(TOTAL), chunkSize),
        failStatus,
    };
    servers.set(URL, server);
    return server;
}

test('ply: normal load writes every point and a full bounding box', async () => {
    const servers = installFetchMock();
    registerServer(servers, 101); // crosses the 200-byte header buffering boundary oddly
    const model = makeModel(1000);

    await loadPly(model);

    assert.equal(model.status, ModelStatus.FetchDone);
    assert.equal(model.modelSplatCount, TOTAL);
    assert.equal(model.dataSplatCount, TOTAL);
    assert.equal(model.downloadSplatCount, TOTAL);
    assert.equal(model.splatData.byteLength, TOTAL * 32);
    assert.equal(model.minX, 0);
    assert.equal(model.maxX, TOTAL - 1);
    assert.equal(model.maxY, (TOTAL - 1) * 10);
    assert.equal(model.maxZ, (TOTAL - 1) * 100);
});

test('ply: fetchLimit stop keeps the subset, marks FetchDone and bbox matches the subset only', async () => {
    const servers = installFetchMock();
    registerServer(servers, 68); // rowLength=68 -> exactly one splat per chunk after header
    const limit = 6;
    const model = makeModel(limit);

    await loadPly(model);

    assert.equal(model.status, ModelStatus.FetchDone);
    assert.equal(model.fetchLimitReached, true);
    assert.equal(model.dataSplatCount, limit);
    assert.equal(model.downloadSplatCount, limit);
    assert.equal(model.maxX, limit - 1);
    assert.equal(model.maxZ, (limit - 1) * 100);
    // dropped points (limit..TOTAL) must never influence min/max
    assert.ok(model.maxX < TOTAL - 1);
});

test('ply: user cancel discards partial data and a retry on the same model is clean', async () => {
    const servers = installFetchMock();
    const server = registerServer(servers, 68);
    const model = makeModel(1000);

    const loading = loadPly(model);
    await server.whenReads(4);
    assert.ok(model.downloadSplatCount > 0 || model.downloadSize > 0);

    model.cancelLoad();
    await loading;

    assert.equal(model.status, ModelStatus.FetchAborted);
    assert.equal(model.dataSplatCount, 0);
    assert.equal(model.downloadSplatCount, 0);
    assert.equal(model.splatData, null);
    assert.equal(model.sh12Data.length, 0);
    assert.equal(model.minX, Infinity);
    assert.equal(model.maxX, -Infinity);
    assert.equal(model.aabbCenter, null);

    registerServer(servers, 200);
    await loadPly(model);
    assert.equal(model.status, ModelStatus.FetchDone);
    assert.equal(model.loadSessionId, 2);
    assert.equal(model.dataSplatCount, TOTAL);
    assert.equal(model.maxX, TOTAL - 1);
});

test('ply: failed load leaves no residue and retry succeeds from scratch', async () => {
    const servers = installFetchMock();
    registerServer(servers, 64, 500);
    const model = makeModel(1000);
    model.dataSplatCount = 11;
    model.sh12Data = [new Uint8Array([9])];
    model.maxX = 999;

    await loadPly(model);
    assert.equal(model.status, ModelStatus.FetchFailed);
    assert.equal(model.dataSplatCount, 0);
    assert.equal(model.sh12Data.length, 0);
    assert.equal(model.maxX, -Infinity);

    registerServer(servers, 137);
    await loadPly(model);
    assert.equal(model.status, ModelStatus.FetchDone);
    assert.equal(model.dataSplatCount, TOTAL);
    assert.equal(model.minX, 0);
    assert.equal(model.maxX, TOTAL - 1);
    assert.equal(model.maxZ, (TOTAL - 1) * 100);
});

test('ply: interleaved sessions isolate data and bounding box', async () => {
    const servers = installFetchMock();
    const first = registerServer(servers, 68);
    const model = makeModel(1000);

    const firstLoad = loadPly(model);
    await first.whenReads(3);
    assert.equal(model.loadSessionId, 1);

    const second = registerServer(servers, 68);
    const secondLoad = loadPly(model);
    assert.equal(model.loadSessionId, 2);

    await firstLoad;
    await second.whenReads(2);
    await secondLoad;

    assert.equal(model.status, ModelStatus.FetchDone);
    assert.equal(model.dataSplatCount, TOTAL);
    assert.equal(model.maxX, TOTAL - 1);
    assert.equal(model.maxZ, (TOTAL - 1) * 100);
});

test('ply: bbox is driven only by bytes actually written after fetchLimit truncation', async () => {
    const servers = installFetchMock();
    // One big chunk carries more splats than the limit; the surplus is dropped
    // inside the parser and must not touch the bounding box.
    registerServer(servers, 5000);
    const limit = 3;
    const model = makeModel(limit);

    await loadPly(model);

    assert.equal(model.status, ModelStatus.FetchDone);
    assert.equal(model.dataSplatCount, limit);
    assert.deepEqual(
        { minX: model.minX, maxX: model.maxX, minY: model.minY, maxY: model.maxY, minZ: model.minZ, maxZ: model.maxZ },
        { minX: 0, maxX: limit - 1, minY: 0, maxY: (limit - 1) * 10, minZ: 0, maxZ: (limit - 1) * 100 },
    );
});
