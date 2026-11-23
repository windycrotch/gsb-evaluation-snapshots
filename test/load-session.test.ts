import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FetchAbortReason, ModelStatus, SplatModel } from '../src/reall3d/modeldata/ModelData';
import { LoadSession, writeSplatData, discardPartialData } from '../src/reall3d/modeldata/loaders/LoadSession';

function makeModel(): SplatModel {
    const model = new SplatModel({ url: 'test://m.splat', format: 'splat' });
    model.fetchLimit = 100;
    return model;
}

/**
 * Mirror the real loader ordering: start() resets all mutable state (including
 * modelSplatCount=-1), then the header is parsed and the count/buffer set.
 */
function startWithCount(model: SplatModel, count: number, limit?: number): LoadSession {
    const session = LoadSession.start(model);
    if (limit !== undefined) model.fetchLimit = limit;
    model.modelSplatCount = count;
    model.splatData = new Uint8Array(Math.min(model.fetchLimit, count) * 32);
    return session;
}

test('LoadSession: each start increments the id and resets all mutable state', () => {
    const model = makeModel();
    const s1 = LoadSession.start(model);
    assert.equal(s1.id, 1);
    assert.equal(model.status, ModelStatus.Fetching);

    // Simulate a partial first session.
    model.splatData = new Uint8Array(10 * 32);
    model.dataSplatCount = 10;
    model.downloadSplatCount = 10;
    model.sh12Data = [new Uint8Array([1])];
    model.minX = 1;
    model.maxX = 2;
    model.abortReason = FetchAbortReason.UserCancel;

    const s2 = LoadSession.start(model);
    assert.equal(s2.id, 2);
    assert.equal(s1.isCurrent(), false, 'old session is no longer current');
    assert.equal(s2.isCurrent(), true);
    assert.equal(model.dataSplatCount, 0);
    assert.equal(model.downloadSplatCount, 0);
    assert.equal(model.splatData, null);
    assert.equal(model.sh12Data.length, 0);
    assert.equal(model.minX, Infinity);
    assert.equal(model.maxX, -Infinity);
    assert.equal(model.abortReason, FetchAbortReason.None);
});

test('LoadSession: fetchLimit stop finishes as FetchDone and keeps data', () => {
    const model = makeModel();
    const session = startWithCount(model, 100);
    const onePoint = new Uint8Array(32);
    new Float32Array(onePoint.buffer).set([5, 6, 7]);
    writeSplatData(model, onePoint);
    assert.equal(model.dataSplatCount, 1);
    assert.equal(model.minX, 5);

    session.stopAtFetchLimit();
    assert.equal(model.abortReason, FetchAbortReason.FetchLimit);
    const status = session.resolveTerminalStatus(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    assert.equal(status, ModelStatus.FetchDone);
    assert.equal(model.dataSplatCount, 1, 'limit stop keeps the parsed subset');
    assert.equal(model.minX, 5, 'limit stop keeps the bounding box');
});

test('LoadSession: user cancellation discards counts, SH and bounding box', () => {
    const model = makeModel();
    const session = startWithCount(model, 100);
    writeSplatData(model, new Uint8Array(3 * 32));
    model.sh12Data.push(new Uint8Array([1, 2, 3]));
    assert.equal(model.dataSplatCount, 3);

    model.cancelLoad();
    const status = session.resolveTerminalStatus(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    assert.equal(status, ModelStatus.FetchAborted);
    assert.equal(model.abortReason, FetchAbortReason.UserCancel);
    assert.equal(model.splatData, null);
    assert.equal(model.dataSplatCount, 0);
    assert.equal(model.sh12Data.length, 0);
    assert.equal(model.minX, Infinity);
    assert.equal(model.maxX, -Infinity);
    assert.equal(model.aabbCenter, null);
});

test('LoadSession: a stale session cannot overwrite the newer session terminal status', () => {
    const model = makeModel();
    const old = LoadSession.start(model);
    LoadSession.start(model); // supersedes `old`

    // Old fetch rejects late; it must not touch the model.
    const status = old.resolveTerminalStatus(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    assert.equal(status, ModelStatus.Fetching, 'stale session returns the current model status unchanged');
    assert.equal(model.status, ModelStatus.Fetching);
});

test('writeSplatData: dropped surplus rows never participate in the bounding box', () => {
    const model = makeModel();
    // 3 points in the model, limit 2 -> buffer holds 2 rows; the third offered
    // point (x=999) is dropped and must not extend the bounding box.
    startWithCount(model, 3, 2);

    const offered = new Uint8Array(3 * 32);
    const f32 = new Float32Array(offered.buffer);
    f32[0] = 1; f32[1] = 1; f32[2] = 1;
    f32[8] = 2; f32[9] = 2; f32[10] = 2;
    f32[16] = 999; f32[17] = 999; f32[18] = 999;

    const written = writeSplatData(model, offered);
    assert.equal(written, 2);
    assert.equal(model.dataSplatCount, 2);
    assert.equal(model.maxX, 2, 'the dropped point at x=999 must not extend the bbox');
    assert.equal(model.maxY, 2);
    assert.equal(model.maxZ, 2);
});

test('discardPartialData: clears every partial artifact', () => {
    const model = makeModel();
    model.splatData = new Uint8Array(8 * 32);
    model.dataSplatCount = 8;
    model.downloadSplatCount = 8;
    model.sh12Data = [new Uint8Array(8)];
    model.sh3Data = [new Uint8Array(8)];
    model.minX = -3; model.maxX = 3;
    discardPartialData(model);
    assert.equal(model.splatData, null);
    assert.equal(model.dataSplatCount, 0);
    assert.equal(model.downloadSplatCount, 0);
    assert.equal(model.sh12Data.length, 0);
    assert.equal(model.sh3Data.length, 0);
    assert.equal(model.minX, Infinity);
    assert.equal(model.maxZ, -Infinity);
    assert.equal(model.aabbCenter, null);
});
