/*
 * In-memory Firebase stand-in for the local acceptance page.
 * It implements only the surface used by js/main.js:
 *   firebase.storage().ref().child(name).put(file)
 *   firebase.database().ref().child('songs').on('child_added', cb)
 *   firebase.database().ref().child('songs').child(name).set(url)
 * No network access and no real credentials are involved.
 */
window.firebase = (function () {
    var songs = [];
    var childAddedListeners = [];

    function snapshotFor(entry) {
        return {
            key: entry.key,
            val: function () { return entry.url; }
        };
    }

    function makeRef(path) {
        return {
            child: function (key) {
                return makeRef(path.concat(key));
            },
            on: function (event, callback) {
                if (event !== 'child_added') return;
                childAddedListeners.push(callback);
                songs.slice().forEach(function (entry) {
                    callback(snapshotFor(entry));
                });
            },
            set: function (value) {
                var key = path[path.length - 1];
                var existing = songs.filter(function (s) { return s.key === key; })[0];
                if (existing) {
                    existing.url = value;
                } else {
                    songs.push({ key: key, url: value });
                }
                childAddedListeners.forEach(function (callback) {
                    callback(snapshotFor({ key: key, url: value }));
                });
                return Promise.resolve();
            }
        };
    }

    return {
        initializeApp: function () {},
        storage: function () {
            return {
                ref: function () {
                    return {
                        child: function (name) {
                            return {
                                put: function () {
                                    return Promise.resolve({
                                        downloadURL: 'blob:firebase-stub/' + encodeURIComponent(name)
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
                    return makeRef([]);
                }
            };
        },
        // Test-only seeding API. Safe to call after the app has loaded:
        // any registered child_added listener receives the new entries.
        __seedSongs: function (entries) {
            entries.forEach(function (entry) {
                songs.push({ key: entry.key, url: entry.url });
                childAddedListeners.forEach(function (callback) {
                    callback(snapshotFor(entry));
                });
            });
        }
    };
})();
