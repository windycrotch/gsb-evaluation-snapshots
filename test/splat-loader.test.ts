import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SplatModel, ModelStatus } from '../src/reall3d/modeldata/ModelData';
import { loadSplat } from '../src/reall3d/modeldata/loaders/SplatLoader';
import { buildSplatFile, chunkBytes, installFetchMock, MockServer } from './mockFetch';

const URL = 'test://model.splat';
const TOTAL = 40;

function makeModel(fetchLimit: number): SplatModel {
    const model = new SplatModel({ url: URL, format: 'splat' });
    model.fetchLimit = fetchLimit;
    return model;
}

function registerServer(servers: Map<string, MockServer>, chunkSize: number, failStatus?: number): MockServer {
    const server: any = {
        url: URL,
        chunks: failStatus ? [] : chunkBytes(buildSplatFile(TOTAL), chunkSize),
        failStatus,
    };
    servers.set(URL, server);
    return server;
}

function bbox(model: SplatModel) {
    return {
        minX: model.minX,
        maxX: model.maxX,
        minY: model.minY,
        maxY: model.maxY,
        minZ: model.minZ,
        maxZ: model.maxZ,
    };
}

test('splat: normal load writes every point and a full bounding box', async () => {
    const servers = installFetchMock();
    registerServer(servers, 37); // intentionally not 32-aligned -> multi-slice buffering
    const model = makeModel(1000);

    await loadSplat(model);

    assert.equal(model.status, ModelStatus.FetchDone);
    assert.equal(model.modelSplatCount, TOTAL);
    assert.equal(model.dataSplatCount, TOTAL);
    assert.equal(model.downloadSplatCount, TOTAL);
    assert.equal(model.splatData.byteLength, TOTAL * 32);

    // bbox covers all points: x = i, y = 10i, z = 100i
    assert.deepEqual(bbox(model), { minX: 0, maxX: TOTAL - 1, minY: 0, maxY: (TOTAL - 1) * 10, minZ: 0, maxZ: (TOTAL - 1) * 100 });
});

test('splat: reaching fetchLimit keeps the parsed subset, marks FetchDone and bbox reflects the subset', async () => {
    const servers = installFetchMock();
    registerServer(servers, 32);
    const limit = 10;
    const model = makeModel(limit);

    await loadSplat(model);

    assert.equal(model.status, ModelStatus.FetchDone, 'limit stop is a completed (partial) load, not aborted');
    assert.equal(model.fetchLimitReached, true);
    assert.equal(model.dataSplatCount, limit);
    assert.equal(model.downloadSplatCount, limit);
    assert.equal(model.splatData.byteLength, limit * 32);

    // bbox only spans the loaded subset (points 0..9), never the full model
    assert.equal(model.minX, 0);
    assert.equal(model.maxX, limit - 1);
    assert.equal(model.maxY, (limit - 1) * 10);
    assert.equal(model.maxZ, (limit - 1) * 100);
});

test('splat: user cancellation discards partial data, marks FetchAborted, and retry starts clean', async () => {
    const servers = installFetchMock();
    const server = registerServer(servers, 32);
    const model = makeModel(1000);

    const loading = loadSplat(model);
    await server.whenReads(3); // 3 splats delivered and parsed before cancel
    assert.ok(model.dataSplatCount > 0);

    model.cancelLoad();
    await loading;

    assert.equal(model.status, ModelStatus.FetchAborted);
    assert.equal(model.fetchLimitReached, false);
    assert.equal(model.dataSplatCount, 0, 'cancelled partial data must be discarded');
    assert.equal(model.downloadSplatCount, 0);
    assert.equal(model.splatData, null);
    assert.equal(model.sh12Data.length, 0);
    assert.ok(model.minX === Infinity && model.maxX === -Infinity, 'bbox must be reset after cancel');
    assert.equal(model.aabbCenter, null);

    // Retry the same model instance: it must start from a clean state.
    registerServer(servers, 64);
    await loadSplat(model);

    assert.equal(model.status, ModelStatus.FetchDone);
    assert.equal(model.loadSessionId, 2, 'retry opened a new session');
    assert.equal(model.dataSplatCount, TOTAL, 'no leftover counters from the cancelled attempt');
    assert.equal(model.downloadSplatCount, TOTAL);
    assert.equal(model.maxX, TOTAL - 1);
});

test('splat: failure marks FetchFailed and a later retry starts from a clean state', async () => {
    const servers = installFetchMock();
    registerServer(servers, 32, 500);
    const model = makeModel(1000);

    // seed stale state as if a previous attempt had partially run
    model.dataSplatCount = 7;
    model.downloadSplatCount = 7;
    model.sh12Data = [new Uint8Array([1, 2, 3])];
    model.minX = 123;
    model.maxX = 456;

    await loadSplat(model);
    assert.equal(model.status, ModelStatus.FetchFailed);
    assert.equal(model.dataSplatCount, 0, 'session start resets counters before the failing fetch');
    assert.equal(model.sh12Data.length, 0);
    assert.equal(model.minX, Infinity);

    registerServer(servers, 40); // healthy server now
    await loadSplat(model);

    assert.equal(model.status, ModelStatus.FetchDone);
    assert.equal(model.dataSplatCount, TOTAL);
    assert.equal(model.minX, 0);
    assert.equal(model.maxX, TOTAL - 1);
    assert.deepEqual(bbox(model).maxZ, (TOTAL - 1) * 100);
});

test('splat: interleaved sessions — late chunks of the old session never reach the new session', async () => {
    const servers = installFetchMock();
    const firstServer = registerServer(servers, 32);
    const model = makeModel(1000);

    const firstLoad = loadSplat(model);
    await firstServer.whenReads(2); // 2 splats belong to session 1
    const firstSessionId = model.loadSessionId;
    assert.equal(firstSessionId, 1);

    // User switches model / re-triggers while session 1 is still streaming.
    const secondServer = registerServer(servers, 32);
    const secondLoad = loadSplat(model);
    assert.equal(model.loadSessionId, 2);

    await firstLoad; // old fetch rejects with AbortError; its late slices are dropped
    await secondServer.whenReads(1);
    await secondLoad;

    assert.equal(model.status, ModelStatus.FetchDone);
    assert.equal(model.dataSplatCount, TOTAL);
    assert.equal(model.downloadSplatCount, TOTAL);
    // bounding box comes solely from session 2's full file, not session 1 leftovers
    assert.equal(model.minX, 0);
    assert.equal(model.maxX, TOTAL - 1);
    assert.equal(model.maxZ, (TOTAL - 1) * 100);
});

test('splat: repeated loads do not double-count points', async () => {
    const servers = installFetchMock();
    registerServer(servers, 32);
    const model = makeModel(1000);

    await loadSplat(model);
    assert.equal(model.dataSplatCount, TOTAL);
    const firstBbox = bbox(model);

    registerServer(servers, 32);
    await loadSplat(model);

    assert.equal(model.dataSplatCount, TOTAL, 'second load must reset, not accumulate');
    assert.equal(model.downloadSplatCount, TOTAL);
    assert.equal(model.splatData.byteLength, TOTAL * 32);
    assert.deepEqual(bbox(model), firstBbox);
});
