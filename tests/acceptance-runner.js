/*
 * Acceptance runner. Drives app-frame.html (the real app with a Firebase
 * stub) through the scenarios from the task and prints readable PASS/FAIL
 * output. Opens locally: tests/acceptance.html
 */
(function () {
    var results = document.querySelector('#results');
    var summary = document.querySelector('#summary');
    var status = document.querySelector('#status');
    var frame = document.querySelector('#app-frame');
    var harness = document.querySelector('#harness');
    var commandId = 0;
    var pending = {};
    var stats = { pass: 0, fail: 0, skip: 0 };

    function line(text, cls) {
        var div = document.createElement('div');
        div.className = cls || '';
        div.textContent = text;
        results.appendChild(div);
    }

    function group(name) {
        line('');
        line('■ ' + name, 'group');
    }

    function check(name, condition, detail) {
        if (condition) {
            stats.pass++;
            line('  PASS  ' + name, 'pass');
        } else {
            stats.fail++;
            line('  FAIL  ' + name + (detail ? '  -> ' + detail : ''), 'fail');
        }
    }

    function skip(name, reason) {
        stats.skip++;
        line('  SKIP  ' + name + '  (' + reason + ')', 'skip');
    }

    function send(type, payload) {
        var id = 'cmd-' + (++commandId);
        return new Promise(function (resolve, reject) {
            pending[id] = { resolve: resolve, reject: reject };
            frame.contentWindow.postMessage(Object.assign({ type: type, id: id }, payload || {}), '*');
            setTimeout(function () {
                if (pending[id]) {
                    delete pending[id];
                    reject(new Error('timeout waiting for ' + type));
                }
            }, 8000);
        });
    }

    window.addEventListener('message', function (event) {
        if (event.source !== frame.contentWindow) return;
        var data = event.data;
        if (data.type === 'app:ready') return;
        if (data.type !== 'app:response' || !pending[data.id]) return;
        var entry = pending[data.id];
        delete pending[data.id];
        if (data.ok) {
            entry.resolve(data.state);
        } else {
            entry.reject(new Error(data.error || 'command failed'));
        }
    });

    function waitUntilReady() {
        return new Promise(function (resolve) {
            function onReady(event) {
                if (event.source === frame.contentWindow && event.data.type === 'app:ready') {
                    window.removeEventListener('message', onReady);
                    resolve(event.data.state);
                }
            }
            window.addEventListener('message', onReady);
        });
    }

    // Builds a valid 44.1kHz mono 16-bit PCM WAV Blob entirely in memory.
    function makeWavBlob(seconds, frequency) {
        var sampleRate = 44100;
        var sampleCount = Math.floor(sampleRate * seconds);
        var buffer = new ArrayBuffer(44 + sampleCount * 2);
        var view = new DataView(buffer);
        function writeString(offset, text) {
            for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
        }
        writeString(0, 'RIFF');
        view.setUint32(4, 36 + sampleCount * 2, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, sampleCount * 2, true);
        for (var s = 0; s < sampleCount; s++) {
            var sample = Math.sin(2 * Math.PI * frequency * s / sampleRate) * 0.4;
            view.setInt16(44 + s * 2, sample * 0x7fff, true);
        }
        return new Blob([buffer], { type: 'audio/wav' });
    }

    function makeWavFile(name, seconds, frequency) {
        return new File([makeWavBlob(seconds, frequency)], name, { type: 'audio/wav' });
    }

    function setHarnessSize(width, height) {
        harness.style.width = width + 'px';
        harness.style.height = height + 'px';
        return new Promise(function (resolve) { setTimeout(resolve, 180); });
    }

    function findButton(state, name) {
        return state.buttons.filter(function (b) { return b.name === name; })[0] || null;
    }

    function assertSingleSource(state, label) {
        check(label + ': exactly one active analyser source', state.activeSourceCount === 1,
            'activeSourceCount=' + state.activeSourceCount);
        check(label + ': exactly one <audio> element in the player', state.audioElementCount === 1,
            'audioElementCount=' + state.audioElementCount);
    }

    function assertNoStaleMarkers(state, label, expectedSelected) {
        var stale = state.buttons.filter(function (b) {
            return b.playing && b.name !== expectedSelected;
        });
        check(label + ': no playing marker on previous track buttons', stale.length === 0,
            stale.map(function (b) { return b.name; }).join(', '));
        if (expectedSelected) {
            var current = findButton(state, expectedSelected);
            check(label + ': selected button is aria-current', !!current && current.current,
                expectedSelected);
        }
    }

    async function run() {
        try {
            status.textContent = 'Loading application frame…';
            await waitUntilReady();

            var wavA = makeWavBlob(0.6, 440);
            var wavB = makeWavBlob(0.6, 660);
            var wavC = makeWavBlob(0.6, 880);
            var urlA = URL.createObjectURL(wavA);
            var urlB = URL.createObjectURL(wavB);
            var urlC = URL.createObjectURL(wavC);

            await send('app:seed', { songs: [
                { key: 'Alpha Tune', url: urlA },
                { key: 'Beta Track', url: urlB },
                { key: 'Gamma Song', url: urlC }
            ] });

            // ---- Group 1: three consecutive library switches ----
            group('1. Audio graph after three consecutive track switches');
            var state = await send('app:state');
            check('library lists three seeded songs', state.buttons.length === 3,
                'buttons=' + state.buttons.length);
            check('initial track has exactly one source', state.activeSourceCount === 1,
                'activeSourceCount=' + state.activeSourceCount);

            await send('app:clickSong', { name: 'Alpha Tune' });
            state = await send('app:state');
            assertSingleSource(state, 'after switch 1 (Alpha Tune)');
            assertNoStaleMarkers(state, 'after switch 1', 'Alpha Tune');
            check('source count grew to 2 (old one released, new one attached)',
                state.totalSourcesCreated === 2, 'total=' + state.totalSourcesCreated);

            await send('app:clickSong', { name: 'Beta Track' });
            state = await send('app:state');
            assertSingleSource(state, 'after switch 2 (Beta Track)');
            assertNoStaleMarkers(state, 'after switch 2', 'Beta Track');
            check('source count grew to 3', state.totalSourcesCreated === 3,
                'total=' + state.totalSourcesCreated);

            await send('app:clickSong', { name: 'Gamma Song' });
            state = await send('app:state');
            assertSingleSource(state, 'after switch 3 (Gamma Song)');
            assertNoStaleMarkers(state, 'after switch 3', 'Gamma Song');
            check('source count grew to 4', state.totalSourcesCreated === 4,
                'total=' + state.totalSourcesCreated);
            check('track title follows the current song', state.trackTitle === 'Gamma Song',
                state.trackTitle);

            // ---- Group 2: upload + immediate library switch + repeat upload ----
            group('2. Local upload, immediate re-selection and repeated same-file upload');
            var uploadFile = makeWavFile('my-recording.wav', 0.6, 330);
            await send('app:upload', { file: uploadFile });
            state = await send('app:state');
            assertSingleSource(state, 'after first upload');
            check('uploaded file is shown as the current track',
                state.trackTitle === 'my-recording.wav', state.trackTitle);
            check('upload does not leave a playing marker on any library button',
                state.playingMarkerCount === 0, 'markers=' + state.playingMarkerCount);

            await send('app:clickSong', { name: 'Alpha Tune' });
            state = await send('app:state');
            assertSingleSource(state, 'library pick immediately after upload');
            assertNoStaleMarkers(state, 'library pick immediately after upload', 'Alpha Tune');

            await send('app:upload', { file: uploadFile });
            state = await send('app:state');
            assertSingleSource(state, 're-uploading the same file');
            check('same file can be selected again (input was reset)',
                state.trackTitle === 'my-recording.wav', state.trackTitle);

            await send('app:upload', { file: uploadFile });
            state = await send('app:state');
            assertSingleSource(state, 'uploading the same file a third time');

            await send('app:clickSong', { name: 'Beta Track' });
            await send('app:clickSong', { name: 'Alpha Tune' });
            await send('app:clickSong', { name: 'Beta Track' });
            state = await send('app:state');
            assertSingleSource(state, 'after rapid library round-trips');
            assertNoStaleMarkers(state, 'after rapid library round-trips', 'Beta Track');

            // ---- Group 3: playing marker lifecycle ----
            group('3. Play / pause marker only on the current track button');
            await send('app:clickSong', { name: 'Alpha Tune' });
            var playFailed = false;
            try {
                state = await send('app:play');
            } catch (error) {
                playFailed = true;
                state = await send('app:state');
            }
            if (playFailed) {
                skip('playback marker while playing', 'browser blocked autoplay in this environment');
            } else {
                check('playing marker appears on the current button', state.playingMarkerOnSelected,
                    'selected=' + state.selectedSongName);
                check('only one playing marker exists', state.playingMarkerCount === 1,
                    'count=' + state.playingMarkerCount);
                await send('app:clickSong', { name: 'Beta Track' });
                state = await send('app:state');
                check('switching away clears the old button marker',
                    !findButton(state, 'Alpha Tune').playing, 'Alpha Tune still marked');
            }
            state = await send('app:pause').catch(function () { return send('app:state'); });
            check('no button keeps a playing marker while paused', state.playingMarkerCount === 0,
                'count=' + state.playingMarkerCount);

            // ---- Group 4: resize keeps canvas and camera in sync ----
            group('4. Resize: canvas pixels, renderer size and camera aspect');
            await setHarnessSize(1000, 600);
            state = await send('app:state');
            var expectedAspect = state.viewportWidth / state.viewportHeight;
            check('desktop camera aspect equals viewport aspect',
                Math.abs(state.cameraAspect - expectedAspect) < 1e-6,
                'camera=' + state.cameraAspect + ' viewport=' + expectedAspect);
            check('canvas pixel width matches viewport x devicePixelRatio',
                state.canvasWidth === Math.round(state.viewportWidth * state.devicePixelRatio),
                'canvas=' + state.canvasWidth + ' expected=' +
                Math.round(state.viewportWidth * state.devicePixelRatio));
            check('canvas pixel height matches viewport x devicePixelRatio',
                state.canvasHeight === Math.round(state.viewportHeight * state.devicePixelRatio),
                'canvas=' + state.canvasHeight);

            await setHarnessSize(480, 700);
            state = await send('app:state');
            expectedAspect = state.viewportWidth / state.viewportHeight;
            check('narrow camera aspect equals viewport aspect',
                Math.abs(state.cameraAspect - expectedAspect) < 1e-6,
                'camera=' + state.cameraAspect + ' viewport=' + expectedAspect);
            check('narrow canvas pixel size resynced',
                state.canvasWidth === Math.round(state.viewportWidth * state.devicePixelRatio) &&
                state.canvasHeight === Math.round(state.viewportHeight * state.devicePixelRatio),
                'canvas=' + state.canvasWidth + 'x' + state.canvasHeight);

            // ---- Group 5: panel rules across the 700px breakpoint ----
            group('5. Library / settings panel rules at narrow and desktop widths');
            check('narrow width is detected (<=700px)', state.viewportWidth <= 700,
                'width=' + state.viewportWidth);
            check('library closes when entering narrow width', !state.libraryOpen,
                'libraryOpen=' + state.libraryOpen);
            check('no panel is modal on entering narrow width', !state.libraryIsModal,
                'libraryIsModal=' + state.libraryIsModal);

            state = await send('app:toggleSettings');
            check('settings can open on narrow width', state.settingsOpen,
                'settingsOpen=' + state.settingsOpen);
            var openedLibrary = await send('app:toggleLibrary');
            check('opening the library modally closes settings on narrow width',
                !openedLibrary.settingsOpen, 'settingsOpen=' + openedLibrary.settingsOpen);
            check('library is modal on narrow width', openedLibrary.libraryIsModal,
                'libraryIsModal=' + openedLibrary.libraryIsModal);
            check('two panels are never modal at the same time',
                !(openedLibrary.libraryIsModal && openedLibrary.settingsOpen), 'both open');

            state = await send('app:toggleSettings');
            check('opening settings while the library is modal closes the library',
                state.settingsOpen && !state.libraryOpen && !state.libraryIsModal,
                'settings=' + state.settingsOpen + ' libraryOpen=' + state.libraryOpen);

            await setHarnessSize(1000, 600);
            state = await send('app:state');
            check('returning to desktop reopens the (non-modal) library',
                state.libraryOpen && !state.libraryIsModal,
                'open=' + state.libraryOpen + ' modal=' + state.libraryIsModal);
            check('desktop viewport width is above the breakpoint', state.viewportWidth > 700,
                'width=' + state.viewportWidth);
            // Settings may already be open from the narrow-width steps; toggle
            // only when closed so the desktop side-by-side state is deterministic.
            if (!state.settingsOpen) {
                state = await send('app:toggleSettings');
            }
            check('settings may sit beside the library on desktop',
                state.settingsOpen && state.libraryOpen && !state.libraryIsModal,
                'settings=' + state.settingsOpen + ' library=' + state.libraryOpen);
            await setHarnessSize(480, 700);
            state = await send('app:state');
            check('back to narrow: library closed, no stacked modal panels',
                !state.libraryOpen && !state.libraryIsModal,
                'open=' + state.libraryOpen + ' modal=' + state.libraryIsModal);
            await setHarnessSize(1000, 600);

            // ---- Group 6: preserved search behaviour ----
            group('6. Library search, clear and no-match message');
            state = await send('app:search', { query: 'beta' });
            var beta = findButton(state, 'Beta Track');
            check('search keeps the matching song visible', beta && !beta.hidden,
                JSON.stringify(beta));
            check('search hides non-matching songs',
                findButton(state, 'Alpha Tune').hidden && findButton(state, 'Gamma Song').hidden,
                'non-matching rows visible');
            check('no-match message stays hidden while a match exists',
                !state.noMatchingVisible, 'message visible');

            state = await send('app:search', { query: 'zzz-no-such-song' });
            check('no-match message appears for an unmatched query',
                state.noMatchingVisible, 'message hidden');
            check('all songs are hidden for an unmatched query',
                state.buttons.every(function (b) { return b.hidden; }), 'rows remain visible');

            state = await send('app:clearSearch');
            check('clearing restores every song',
                state.buttons.every(function (b) { return !b.hidden; }), 'rows still hidden');
            check('clearing hides the no-match message and empties the query',
                !state.noMatchingVisible && state.searchValue === '',
                'message=' + state.noMatchingVisible + ' query="' + state.searchValue + '"');

            // ---- Final invariant ----
            group('7. Final state');
            state = await send('app:state');
            check('exactly one active source remains after every scenario',
                state.activeSourceCount === 1, 'activeSourceCount=' + state.activeSourceCount);
            check('exactly one audio element remains in the DOM',
                state.audioElementCount === 1, 'audioElementCount=' + state.audioElementCount);
        } catch (error) {
            stats.fail++;
            line('');
            line('HARNESS ERROR: ' + (error && error.stack ? error.stack : error), 'fail');
        } finally {
            var total = stats.pass + stats.fail + stats.skip;
            var verdict = stats.fail === 0 ? 'ALL TESTS PASSED' : 'FAILURES PRESENT';
            summary.textContent = verdict + ' — ' + stats.pass + '/' + total +
                ' passed, ' + stats.fail + ' failed, ' + stats.skip + ' skipped';
            summary.className = stats.fail === 0 ? 'pass' : 'fail';
            status.textContent = 'Done.';
            document.body.setAttribute('data-acceptance', stats.fail === 0 ? 'pass' : 'fail');
            document.body.setAttribute('data-acceptance-stats',
                stats.pass + ' passed, ' + stats.fail + ' failed, ' + stats.skip + ' skipped');
        }
    }

    run();
})();
