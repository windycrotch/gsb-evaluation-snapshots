// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import { MaxProcessCnt } from '../../utils/GlobalConstants';
import { ModelStatus, SplatModel } from '../ModelData';
import { parseSplatToTexdata } from '../wasm/WasmParser';
import { LoadSession, writeSplatData } from './LoadSession';

export async function loadSplat(model: SplatModel) {
    // Each invocation starts a fresh session: counters, SH data and the
    // bounding box are reset, and a new AbortController is installed.
    const session = LoadSession.start(model);
    let bytesRead = 0;

    try {
        const signal: AbortSignal = model.abortController.signal;
        const cache = model.opts.fetchReload ? 'reload' : 'default';
        const req = await fetch(model.opts.url, { mode: 'cors', credentials: 'omit', cache, signal });
        if (req.status != 200) {
            console.warn(`fetch error: ${req.status}`);
            session.isCurrent() && session.finish(ModelStatus.FetchFailed);
            return;
        }
        const reader = req.body.getReader();
        const contentLength = parseInt(req.headers.get('content-length') || '0');
        model.rowLength = 32;
        model.fileSize = contentLength;
        const maxVertexCount = (contentLength / model.rowLength) | 0;
        if (maxVertexCount < 1) {
            console.warn('data empty', model.opts.url);
            session.isCurrent() && session.finish(ModelStatus.Invalid);
            return;
        }

        model.CompressionRatio = '7.75x';
        model.modelSplatCount = maxVertexCount;
        model.downloadSplatCount = 0;
        model.splatData = new Uint8Array(Math.min(model.modelSplatCount, model.fetchLimit) * 32);
        model.watermarkData = new Uint8Array(0);

        let perValue = new Uint8Array(32);
        let perByteLen: number = 0;

        while (true) {
            // A newer session (reload) or terminal state means this loop is stale.
            if (!session.isCurrent()) return;

            let { done, value } = await reader.read();
            if (done) break;

            if (perByteLen + value.byteLength < model.rowLength) {
                // 不足1点不必解析
                perValue.set(value, perByteLen);
                perByteLen += value.byteLength;

                bytesRead += value.length;
                model.downloadSize = bytesRead;
            } else {
                // 解析并设定数据
                perByteLen = await parseSplatAndSetSplatData(session, perByteLen, perValue, value);
                if (!session.isCurrent()) return; // 旧会话的迟到分片不得写入新会话
                perByteLen && perValue.set(value.subarray(value.byteLength - perByteLen), 0);
            }

            // 达到下载限制时主动中止（保留已解析数据，标记为完成）
            if (model.downloadSplatCount >= model.fetchLimit) {
                session.stopAtFetchLimit();
                break;
            }
        }

        // 自然读毕且未被中止：正常完成
        session.isCurrent() && session.finish(ModelStatus.FetchDone);
    } catch (e) {
        if (e?.name === 'AbortError') {
            console.log('Fetch Abort', model.opts.url);
        } else {
            console.error(e);
        }
        session.resolveTerminalStatus(e);
    }

    async function parseSplatAndSetSplatData(
        session: LoadSession,
        perByteLen: number,
        perValue: Uint8Array,
        newValue: Uint8Array,
    ): Promise<number> {
        return new Promise(async resolve => {
            let cntSplat = ((perByteLen + newValue.byteLength) / model.rowLength) | 0;
            let leave: number = (perByteLen + newValue.byteLength) % model.rowLength;
            let value: Uint8Array;
            if (perByteLen) {
                value = new Uint8Array(cntSplat * model.rowLength);
                value.set(perValue.subarray(0, perByteLen), 0);
                value.set(newValue.subarray(0, newValue.byteLength - leave), perByteLen);
            } else {
                value = newValue.slice(0, cntSplat * model.rowLength);
            }

            // 丢弃超出限制范围外的数据
            if (model.downloadSplatCount + cntSplat > model.fetchLimit) {
                cntSplat = model.fetchLimit - model.downloadSplatCount;
                leave = 0;
            }

            const fnParseSplat = async () => {
                // 会话已切换（重复加载/取消）：丢弃本分片，绝不再触碰 model 数据
                if (!session.isCurrent()) {
                    resolve(leave);
                    return;
                }

                if (cntSplat > MaxProcessCnt) {
                    const data: Uint8Array = await parseSplatToTexdata(value, MaxProcessCnt);
                    if (!session.isCurrent()) {
                        resolve(leave);
                        return;
                    }
                    writeSplatData(model, data);
                    model.downloadSplatCount += MaxProcessCnt;
                    bytesRead += MaxProcessCnt * model.rowLength;
                    model.downloadSize = bytesRead;

                    cntSplat -= MaxProcessCnt;
                    value = value.slice(MaxProcessCnt * model.rowLength);
                    setTimeout(fnParseSplat);
                } else {
                    const data: Uint8Array = await parseSplatToTexdata(value, cntSplat);
                    if (!session.isCurrent()) {
                        resolve(leave);
                        return;
                    }
                    writeSplatData(model, data);
                    model.downloadSplatCount += cntSplat;
                    bytesRead += cntSplat * model.rowLength;
                    model.downloadSize = bytesRead;

                    resolve(leave);
                }
            };

            await fnParseSplat();
        });
    }
}
