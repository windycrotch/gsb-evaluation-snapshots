/*
 * postMessage bridge used by acceptance.html to drive the real app
 * running inside an iframe. Every command gets a matching response so the
 * test runner can sequence steps deterministically.
 */
(function () {
    function send(type, extra) {
        var message = Object.assign({ type: type }, extra || {});
        if (window.parent && window.parent !== window) {
            window.parent.postMessage(message, '*');
        }
    }

    function getDebug() {
        return window.__musicVisualizer || null;
    }

    function libraryButtons() {
        return Array.prototype.slice.call(
            document.querySelectorAll('#prevSongs button')
        ).map(function (button) {
            return {
                name: button.textContent,
                current: button.hasAttribute('aria-current'),
                playing: button.hasAttribute('data-playing'),
                hidden: button.closest('li').hidden,
                connected: button.isConnected
            };
        });
    }

    function collectState() {
        var debug = getDebug();
        var canvas = debug ? debug.canvas : document.querySelector('canvas');
        return {
            ready: !!debug,
            activeSourceCount: debug ? debug.activeSourceCount : null,
            totalSourcesCreated: debug ? debug.totalSourcesCreated : null,
            audioElementCount: debug ? debug.audioElementCount : null,
            selectedSongName: debug ? debug.selectedSongName : null,
            playingMarkerCount: debug ? debug.playingMarkerCount : null,
            playingMarkerOnSelected: debug ? debug.playingMarkerOnSelected : null,
            cameraAspect: debug ? debug.cameraAspect : null,
            canvasWidth: canvas ? canvas.width : null,
            canvasHeight: canvas ? canvas.height : null,
            libraryOpen: document.querySelector('#past-songs').open,
            libraryIsModal: document.querySelector('#past-songs').matches(':modal'),
            settingsOpen: !document.querySelector('#camera-settings').hidden,
            buttons: libraryButtons(),
            searchValue: document.querySelector('#song-search').value,
            noMatchingVisible: !document.querySelector('#no-matching-songs').hidden,
            trackTitle: document.querySelector('#track-title').textContent,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio || 1
        };
    }

    function wait(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms);
        });
    }

    function findButton(name) {
        var buttons = document.querySelectorAll('#prevSongs button');
        for (var i = 0; i < buttons.length; i++) {
            if (buttons[i].textContent === name) return buttons[i];
        }
        return null;
    }

    window.addEventListener('message', async function (event) {
        var command = event.data;
        if (!command || !command.type || command.type.indexOf('app:') !== 0) return;

        try {
            switch (command.type) {
                case 'app:ping':
                    break;
                case 'app:seed':
                    window.firebase.__seedSongs(command.songs);
                    await wait(60);
                    break;
                case 'app:clickSong': {
                    var button = findButton(command.name);
                    if (!button) throw new Error('song button not found: ' + command.name);
                    button.click();
                    await wait(60);
                    break;
                }
                case 'app:upload': {
                    var fileInput = document.querySelector('#audioFile');
                    var transfer = new DataTransfer();
                    transfer.items.add(command.file);
                    fileInput.files = transfer.files;
                    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                    await wait(80);
                    break;
                }
                case 'app:play': {
                    var debug = getDebug();
                    var player = debug.audioPlayer;
                    player.muted = true; // avoid needing audible output in the harness
                    await player.play();
                    await wait(150);
                    break;
                }
                case 'app:pause':
                    getDebug().audioPlayer.pause();
                    await wait(80);
                    break;
                case 'app:search':
                    var search = document.querySelector('#song-search');
                    search.value = command.query;
                    search.dispatchEvent(new Event('input', { bubbles: true }));
                    await wait(40);
                    break;
                case 'app:clearSearch':
                    document.querySelector('#clear-song-search').click();
                    await wait(40);
                    break;
                case 'app:toggleSettings':
                    document.querySelector('#settings-toggle').click();
                    await wait(40);
                    break;
                case 'app:toggleLibrary':
                    document.querySelector('#library-toggle').click();
                    await wait(40);
                    break;
                case 'app:state':
                    break;
                default:
                    throw new Error('unknown command: ' + command.type);
            }
            send('app:response', { id: command.id, ok: true, state: collectState() });
        } catch (error) {
            send('app:response', {
                id: command.id,
                ok: false,
                error: String(error && error.message ? error.message : error),
                state: collectState()
            });
        }
    });

    function announceWhenReady() {
        if (getDebug()) {
            send('app:ready', { state: collectState() });
        } else {
            setTimeout(announceWhenReady, 25);
        }
    }
    announceWhenReady();
})();
