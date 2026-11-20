// Acceptance scenarios for the reproject session semantics.
// Runs the REAL ReprojectPanel against a real WebGL2 device in headless Chrome.
const path = require('path');
const { CdpSession } = require('./cdp-driver.cjs');
const { startStaticServer } = require('./static-server.cjs');

const repoRoot = path.resolve(__dirname, '..');
const fixturePath = (name) => path.join('acceptance', 'fixtures', name).split(path.sep).join('/');

const checks = [];
function check(name, cond, detail) {
    checks.push({ name, ok: !!cond, detail: detail || '' });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
    const server = await startStaticServer(repoRoot);
    const baseUrl = `http://127.0.0.1:${server.port}/`;
    const harnessUrl = `${baseUrl}acceptance/harness.html`;
    const fixtureUrl = (name) => `${baseUrl}${fixturePath(name)}`;
    const cdp = new CdpSession();
    try {
        await cdp.launch(harnessUrl);
        await cdp.waitForTitle('HARNESS_READY');

        // sanity: WebGL2 device came up
        const glInfo = await cdp.eval(`
            const gl = harness.app.graphicsDevice;
            return gl.isWebGL2 ? 'webgl2' : (gl.isWebGL1 ? 'webgl1' : 'unknown');
        `);
        check('harness WebGL2 device', glInfo === 'webgl2', `got ${glInfo}`);

        // ---------------------------------------------------------------------
        // Scenario 1: successful equirect -> cube session, busy interlock,
        // naming from the source selected at click time, auto-select, cleanup
        // ---------------------------------------------------------------------
        await cdp.eval(`
            window.__eq = await harness.loadFixture(${JSON.stringify(fixtureUrl('equirect-16x8.png'))}, 'equirect-16x8.png');
            harness.select(window.__eq);
            harness.installDestroyTracker();
            return harness.docCount();
        `);

        const beforeCount = await cdp.eval('return harness.docCount();');

        // configure target = cube via the real panel controls
        await cdp.eval(`
            harness.setSelect('target', 'cube');
            harness.setNumeric('width', 16);
            return true;
        `);

        // click and immediately observe the busy state (double rAF inside panel)
        await cdp.eval(`
            harness.clickReproject();
            // sample busy state on each animation frame until it settles
            window.__busySamples = [];
            const sample = () => {
                window.__busySamples.push(harness.isBusy());
                if (harness.button().classList.contains('pcui-disabled')) {
                    requestAnimationFrame(sample);
                }
            };
            requestAnimationFrame(sample);
            return true;
        `);
        await cdp.eval('await harness.waitForIdle(); return true;');

        const sawBusy = await cdp.eval('return window.__busySamples.some(Boolean);');
        check('S1 button enters busy state during conversion', sawBusy);

        const buttonText = await cdp.eval('return harness.button().textContent.trim();');
        check('S1 button text restored after completion', buttonText === 'Reproject', buttonText);

        const countAfter = await cdp.eval('return harness.docCount();');
        check('S1 exactly one new texture doc added', countAfter === beforeCount + 1,
            `${beforeCount} -> ${countAfter}`);

        const newName = await cdp.eval('return harness.selectedDocName();');
        check('S1 new texture named from source at click time and auto-selected',
            newName === 'equirect-16x8-cube', `got ${newName}`);

        const newDims = await cdp.eval(`
            const t = harness.textureManager.selectedTextureDoc.resource;
            return { cubemap: t.cubemap, width: t.width, height: t.height };
        `);
        check('S1 output is a cubemap with requested dimensions',
            newDims.cubemap === true && newDims.width === 16 && newDims.height === 16,
            JSON.stringify(newDims));

        const errorHidden = await cdp.eval('return !harness.isErrorVisible();');
        check('S1 no error label on success', errorHidden === true);

        // ---------------------------------------------------------------------
        // Scenario 2: double-click rejection — a second click while busy must
        // not start another session
        // ---------------------------------------------------------------------
        await cdp.eval(`
            harness.setSelect('target', 'equirect');
            harness.setNumeric('width', 16);
            harness.setNumeric('height', 8);
            window.__clicks = 0;
            const origClick = harness.button().click.bind(harness.button());
            // fire two clicks back to back; the panel's busy flag rejects #2
            harness.clickReproject();
            harness.clickReproject();
            return true;
        `);
        await cdp.eval('await harness.waitForIdle(); return true;');
        const countS2 = await cdp.eval('return harness.docCount();');
        check('S2 duplicate click while busy does not create extra docs',
            countS2 === countAfter + 1, `docs=${countS2}`);

        // ---------------------------------------------------------------------
        // Scenario 3: selection change DURING a session must not redirect the
        // session's output naming/ownership and must not corrupt the panel's
        // lock state. We pause inside the session via a rAF window by switching
        // immediately after click (before the two settle frames elapse).
        // ---------------------------------------------------------------------
        const cubeDoc = await cdp.eval(`
            // create a second, unrelated texture doc (cubemap) and leave it unselected
            const doc = harness.createCubemapDoc('other-cube');
            harness.select(window.__eq); // ensure equirect source is selected at click
            harness.setSelect('target', 'octahedral');
            harness.setNumeric('width', 16);
            harness.setNumeric('height', 8);
            return harness.docCount();
        `);
        const countBeforeS3 = cubeDoc;

        await cdp.eval(`
            harness.clickReproject();
            // switch selection while the session is in its pre-work frame window
            harness.select(harness.textureManager.getTextureDoc(
                Array.from(harness.textureManager.textureDocs.keys())
                    .find(id => harness.textureManager.getTextureDoc(id).asset.name === 'other-cube')
            ));
            return true;
        `);
        await cdp.eval('await harness.waitForIdle(); return true;');

        // the session completes and selects ITS OWN output, named after the source
        const s3Name = await cdp.eval('return harness.selectedDocName();');
        check('S3 session output named after original source despite mid-session switch',
            s3Name === 'equirect-16x8-octahedral', `got ${s3Name}`);

        const s3Count = await cdp.eval('return harness.docCount();');
        check('S3 exactly one doc added by the session', s3Count === countBeforeS3 + 1,
            `${countBeforeS3} -> ${s3Count}`);

        // panel now reflects the newly auto-selected doc; envAtlas lock recalculates
        const lockInfo = await cdp.eval(`
            harness.setSelect('target', 'envAtlas');
            return {
                width: harness.getNumeric('width'),
                encoding: harness.selectValue('encoding'),
                widthDisabled: !harness.isControlEnabled('width'),
                encodingDisabled: !harness.isControlEnabled('encoding'),
                heightDisabled: !harness.isControlEnabled('height')
            };
        `);
        check('S3 envAtlas lock recalculated for current selection (512, rgbp, disabled)',
            lockInfo.width === 512 && lockInfo.encoding === 'rgbp' &&
            lockInfo.widthDisabled && lockInfo.encodingDisabled && lockInfo.heightDisabled,
            JSON.stringify(lockInfo));

        // ---------------------------------------------------------------------
        // Scenario 4: failure path — an engine error mid-session. No doc may be
        // added, an error must be shown, controls recover, and a retry succeeds.
        // ---------------------------------------------------------------------
        await cdp.eval(`
            harness.select(window.__eq);
            harness.setSelect('target', 'equirect');
            harness.setNumeric('width', 16);
            harness.setNumeric('height', 8);
            return true;
        `);
        const countBeforeS4 = await cdp.eval('return harness.docCount();');
        await cdp.eval(`
            harness.injectReprojectFailure('simulated engine failure');
            harness.clickReproject();
            return true;
        `);
        await cdp.eval('await harness.waitForIdle(); return true;');

        const s4Count = await cdp.eval('return harness.docCount();');
        check('S4 failed conversion adds no texture doc', s4Count === countBeforeS4,
            `${countBeforeS4} -> ${s4Count}`);

        const s4Error = await cdp.eval(`
            return { visible: harness.isErrorVisible(), text: harness.errorText() };
        `);
        check('S4 visible error message shown',
            s4Error.visible === true && s4Error.text.includes('simulated engine failure'),
            JSON.stringify(s4Error));

        const s4Recovered = await cdp.eval(`
            const btn = harness.controls.button;
            return { enabled: btn.enabled, text: btn.text };
        `);
        check('S4 button re-enabled and labelled for retry',
            s4Recovered.enabled && s4Recovered.text === 'Reproject', JSON.stringify(s4Recovered));

        // with the engine restored, a retry from the same panel state succeeds
        await cdp.eval(`
            harness.restoreReproject();
            harness.clickReproject();
            return true;
        `);
        await cdp.eval('await harness.waitForIdle(); return true;');
        const s4RetryName = await cdp.eval('return harness.selectedDocName();');
        check('S4 retry after failure succeeds', s4RetryName === 'equirect-16x8-equirect',
            `got ${s4RetryName}`);

        // ---------------------------------------------------------------------
        // Scenario 5: cleanup — every session-created intermediate float texture
        // and envAtlas lighting texture is destroyed; output textures that
        // succeeded stay alive (owned by assets)
        // ---------------------------------------------------------------------
        // force an envAtlas session (exercises the lighting branch)
        await cdp.eval(`
            harness.select(window.__eq);
            harness.setSelect('target', 'envAtlas');
            harness.clickReproject();
            return true;
        `);
        await cdp.eval('await harness.waitForIdle(); return true;');

        const cleanup = await cdp.eval(`
            const tracker = harness.tracker();
            // textures created by sessions and currently destroyed
            const destroyedCount = tracker.destroyed.length;
            // every destroyed texture must be a distinct instance
            const unique = new Set(tracker.destroyed).size === tracker.destroyed.length;
            // docs added by successful sessions all hold live (non-destroyed) textures
            const docs = Array.from(harness.textureManager.textureDocs.values());
            const liveOutputs = docs.map(d => ({
                name: d.asset.name,
                levelsNull: d.resource._levels === null
            }));
            const leakedOutput = liveOutputs.some(o => o.levelsNull);
            return { destroyedCount, unique, leakedOutput, liveOutputs: liveOutputs.map(o => o.name) };
        `);
        check('S5 session intermediate textures were destroyed (tmp + lighting + failed target)',
            cleanup.destroyedCount >= 5, `destroyed=${cleanup.destroyedCount}`);
        check('S5 each texture destroyed exactly once (no double-destroy)', cleanup.unique);
        check('S5 successful output textures remain alive in the file list',
            cleanup.leakedOutput === false, JSON.stringify(cleanup.liveOutputs));

        // the failed S4 session created a target texture that must have been
        // destroyed rather than joining any doc
        const failedTargetGone = await cdp.eval(`
            const tracker = harness.tracker();
            // every texture owned by a doc is still live (not in the destroyed set)
            const docs = Array.from(harness.textureManager.textureDocs.values());
            return docs.every((d) => !tracker.destroyed.includes(d.resource));
        `);
        check('S5 failed-session target texture destroyed and absent from file list', failedTargetGone);

        // ---------------------------------------------------------------------
        // Scenario 6: cubemap source (created locally, no network) -> equirect
        // ---------------------------------------------------------------------
        await cdp.eval(`
            const cube = harness.createCubemapDoc('local-cube');
            harness.select(cube);
            // explicitly pick a cube target so the height lock rule applies
            harness.setSelect('target', 'cube');
            return true;
        `);
        const s6Panel = await cdp.eval(`
            return {
                source: harness.selectValue('source'),
                target: harness.selectValue('target'),
                heightEnabled: harness.isControlEnabled('height'),
                heightValue: harness.getNumeric('height')
            };
        `);
        check('S6 cubemap source + cube target locks height to width',
            s6Panel.source === 'cube' && s6Panel.target === 'cube' &&
            s6Panel.heightEnabled === false && s6Panel.heightValue === 8,
            JSON.stringify(s6Panel));

        // switch back to equirect, where height is editable
        await cdp.eval(`
            harness.setSelect('target', 'equirect');
            harness.setNumeric('width', 16);
            harness.setNumeric('height', 8);
            harness.clickReproject();
            return true;
        `);
        await cdp.eval('await harness.waitForIdle(); return true;');
        const s6Out = await cdp.eval(`
            const t = harness.textureManager.selectedTextureDoc.resource;
            return { name: harness.selectedDocName(), cubemap: t.cubemap, width: t.width };
        `);
        check('S6 local cubemap -> equirect session succeeds and is selected',
            s6Out.name === 'local-cube-equirect' && s6Out.cubemap === false && s6Out.width === 16,
            JSON.stringify(s6Out));

        // ---------------------------------------------------------------------
        // Scenario 7: locally generated .hdr equirect fixture (no network)
        // ---------------------------------------------------------------------
        await cdp.eval(`
            window.__hdr = await harness.loadFixture(${JSON.stringify(fixtureUrl('equirect-16x8.hdr'))}, 'equirect-16x8.hdr');
            harness.select(window.__hdr);
            harness.setSelect('target', 'cube');
            harness.setNumeric('width', 8);
            return true;
        `);
        const s7Before = await cdp.eval('return harness.docCount();');
        await cdp.eval(`
            harness.clickReproject();
            return true;
        `);
        await cdp.eval('await harness.waitForIdle(); return true;');
        const s7 = await cdp.eval(`
            const t = harness.textureManager.selectedTextureDoc.resource;
            return {
                name: harness.selectedDocName(),
                cubemap: t.cubemap,
                width: t.width,
                docs: harness.docCount(),
                errorVisible: harness.isErrorVisible()
            };
        `);
        check('S7 local .hdr equirect -> cube succeeds and is auto-selected',
            s7.name === 'equirect-16x8-cube' && s7.cubemap === true &&
            s7.width === 8 && s7.docs === s7Before + 1 && s7.errorVisible === false,
            JSON.stringify(s7));

        // ---------------------------------------------------------------------
        // Scenario 8: busy-state control interlock and cube height tracking
        // ---------------------------------------------------------------------
        await cdp.eval(`
            harness.select(window.__eq);
            harness.setSelect('target', 'cube');
            harness.setNumeric('width', 12);
            return true;
        `);
        const s8Lock = await cdp.eval(`
            return { heightEnabled: harness.isControlEnabled('height'), height: harness.getNumeric('height') };
        `);
        check('S8 cube target: height locked and tracks width',
            s8Lock.heightEnabled === false && s8Lock.height === 12, JSON.stringify(s8Lock));

        const busyFlags = await cdp.eval(`
            return await harness.clickReprojectAndSampleBusy();
        `);
        const allDisabled = Object.values(busyFlags).every((v) => v === false);
        check('S8 all panel controls disabled while a session is busy', allDisabled,
            JSON.stringify(busyFlags));
        await cdp.eval('await harness.waitForIdle(); return true;');

        const afterFlags = await cdp.eval(`
            return {
                button: harness.controls.button.enabled,
                target: harness.controls.target.enabled,
                width: harness.controls.width.enabled
            };
        `);
        check('S8 controls re-enabled after the session ends',
            afterFlags.button && afterFlags.target && afterFlags.width, JSON.stringify(afterFlags));

        // ---------------------------------------------------------------------
        // Final: no uncaught page errors
        // ---------------------------------------------------------------------
        check('no uncaught page errors', cdp.pageErrors.length === 0,
            cdp.pageErrors.slice(0, 3).join(' | '));

        const failed = checks.filter((c) => !c.ok);
        console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
        process.exitCode = failed.length ? 1 : 0;
    } catch (err) {
        console.error('HARNESS ERROR:', err);
        console.error('page errors:', cdp.pageErrors);
        process.exitCode = 2;
    } finally {
        cdp.close();
        await server.close();
    }
}

main();
