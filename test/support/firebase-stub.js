/* Controllable Firebase stand-in served in place of the CDN SDK.
 *
 * The app only uses three pieces of the SDK: initializeApp(), storage().ref()
 * and database().ref(). Everything else here exists so the tests can decide
 * when a song appears in the library and whether an upload should fail.
 */
'use strict';

const STUB_SOURCE = `(function () {
    'use strict';

    var songs = [];
    var listener = null;
    var state = window.__firebaseStub = {
        uploadShouldFail: false,
        uploadDelayMs: 0,
        // Every put() is recorded so tests can assert what was attempted.
        uploads: [],
        // Every database write is recorded so tests can assert what was stored.
        writes: []
    };

    function snapshotFor(key, url) {
        return {
            key: key,
            val: function () { return url; },
            downloadURL: url,
            ref: { getDownloadURL: function () { return Promise.resolve(url); } }
        };
    }

    function deliver(song) {
        if (!listener) return;
        listener(snapshotFor(song.key, song.url));
    }

    function remember(key, url) {
        for (var i = 0; i < songs.length; i += 1) {
            if (songs[i].key === key) {
                songs[i].url = url;
                return false;
            }
        }
        songs.push({ key: key, url: url });
        return true;
    }

    // Test controls -------------------------------------------------------
    state.emitSong = function (key, url) {
        var isNew = remember(key, url);
        if (isNew) deliver({ key: key, url: url });
        return songs.length;
    };
    state.setUploadFailure = function (fail) {
        state.uploadShouldFail = fail;
    };
    state.setUploadDelay = function (ms) {
        state.uploadDelayMs = ms;
    };
    state.songs = function () {
        return songs.slice();
    };

    function makeRef(path) {
        return {
            path: path,
            child: function (name) {
                return makeRef(path ? path + '/' + name : name);
            },
            on: function (event, callback) {
                if (path !== 'songs' || event !== 'child_added') return callback;
                listener = callback;
                songs.slice().forEach(deliver);
                return callback;
            },
            set: function (value) {
                state.writes.push({ path: path, value: value });
                var parts = String(path).split('/');
                if (parts[0] === 'songs' && parts.length > 1) {
                    var key = parts.slice(1).join('/');
                    if (remember(key, value)) deliver({ key: key, url: value });
                }
                return Promise.resolve();
            }
        };
    }

    window.firebase = {
        initializeApp: function () {
            return { name: '[DEFAULT]' };
        },
        storage: function () {
            return {
                ref: function () {
                    return {
                        child: function (name) {
                            return {
                                put: function (file) {
                                    state.uploads.push({ name: name, size: file && file.size });
                                    if (state.uploadShouldFail) {
                                        var failure = new Error('storage/unauthorized');
                                        failure.code = 'storage/unauthorized';
                                        return Promise.reject(failure);
                                    }
                                    var downloadUrl = 'https://firebasestorage.googleapis.com/stub/' +
                                        encodeURIComponent(name) + '?alt=media';
                                    var result = {
                                        downloadURL: downloadUrl,
                                        ref: { getDownloadURL: function () { return Promise.resolve(downloadUrl); } }
                                    };
                                    return new Promise(function (resolve) {
                                        setTimeout(function () { resolve(result); }, state.uploadDelayMs);
                                    });
                                }
                            };
                        }
                    };
                }
            };
        },
        database: function () {
            return {
                ref: function () {
                    return makeRef('');
                }
            };
        }
    };
})();`;

module.exports = { STUB_SOURCE };
