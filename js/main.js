var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
var defaultSong = "https://firebasestorage.googleapis.com/v0/b/kantelabs-threejs.appspot.com/o/03%20-%20Smooth%20Operator.mp3?alt=media&token=27e95f4c-b4fb-4160-9bdc-02833cf65a84";
var defaultSongName = "Smooth Operator";

window.onload = function () {
    var fileUpload = document.querySelector('#audioFile'); //Grabs the file input and stores it in an variable
    var prevSongs = document.querySelector('#prevSongs');
    var songSearch = document.querySelector('#song-search');
    var clearSongSearch = document.querySelector('#clear-song-search');
    var noMatchingSongs = document.querySelector('#no-matching-songs');
    var trackTitle = document.querySelector('#track-title');
    var library = document.querySelector('#past-songs');
    var libraryToggle = document.querySelector('#library-toggle');
    var settings = document.querySelector('#camera-settings');
    var settingsToggle = document.querySelector('#settings-toggle');
    var statusToast = document.querySelector('#status-toast');
    var uploadStatus = document.querySelector('#upload-status');
    var narrowLayout = window.matchMedia('(max-width: 700px)');
    var searchQuery = '';

    // Every song that starts playing owns exactly one of these. Starting a new
    // session disposes the previous one before anything else is created, so
    // there is never more than one audio source, canvas or animation loop.
    var activeSession = null;
    var sessionCount = 0;
    var toastTimer = 0;
    var pendingToast = null;
    var firebaseReady = typeof firebase !== 'undefined' && firebase &&
        typeof firebase.storage === 'function' && typeof firebase.database === 'function';
    var storageRef = null;
    var songsRef = null;

    function getSongFilename(url) {
        try {
            return decodeURIComponent(new URL(url, document.baseURI).pathname).split('/').pop();
        } catch (error) {
            return '';
        }
    }

    // Reports upload outcomes without depending on the console. The inline
    // message is persistent so the failure is still readable after the library
    // closes; the toast mirrors it whenever the library is off screen.
    function reportStatus(message, kind) {
        var isError = kind === 'error';
        if (uploadStatus) {
            uploadStatus.textContent = message;
            uploadStatus.dataset.kind = kind;
            uploadStatus.setAttribute('role', isError ? 'alert' : 'status');
            uploadStatus.hidden = false;
        }
        pendingToast = { message: message, kind: kind };
        syncStatusToast();
    }

    function syncStatusToast() {
        if (!statusToast) return;
        window.clearTimeout(toastTimer);
        if (!pendingToast || library.open) {
            statusToast.hidden = true;
            return;
        }
        statusToast.textContent = pendingToast.message;
        statusToast.dataset.kind = pendingToast.kind;
        statusToast.setAttribute('role', pendingToast.kind === 'error' ? 'alert' : 'status');
        statusToast.hidden = false;
        toastTimer = window.setTimeout(function () {
            statusToast.hidden = true;
        }, pendingToast.kind === 'error' ? 15000 : 6000);
    }

    function updateSearchResults() {
        var hasNoMatches = searchQuery !== '' && !prevSongs.querySelector('li:not([hidden])');
        noMatchingSongs.hidden = !hasNoMatches;
        prevSongs.hidden = hasNoMatches;
    }

    function filterSongs() {
        searchQuery = songSearch.value.trim().toLowerCase();
        for (const item of prevSongs.children) {
            item.hidden = !item.dataset.searchText.includes(searchQuery);
        }
        clearSongSearch.hidden = songSearch.value === '';
        prevSongs.scrollTop = 0;
        updateSearchResults();
    }

    function setLibraryOpen(open) {
        // showModal() throws if the dialog is already modal, and show() throws
        // if it is already open, so only apply real state changes.
        if (open) {
            if (narrowLayout.matches) {
                setSettingsOpen(false);
                if (!library.open) library.showModal();
            } else if (!library.open) {
                library.show();
            }
        } else if (library.open) {
            library.close();
        }
        libraryToggle.hidden = library.open;
        libraryToggle.setAttribute('aria-expanded', String(library.open));
        syncStatusToast();
    }

    function closeLibrary() {
        setLibraryOpen(false);
        libraryToggle.focus();
    }

    function setSettingsOpen(open) {
        if (open && narrowLayout.matches && library.open) setLibraryOpen(false);
        settings.hidden = !open;
        settingsToggle.setAttribute('aria-expanded', String(open));
    }

    function syncLibraryLayout() {
        setLibraryOpen(false);
        if (!narrowLayout.matches) setLibraryOpen(true);
    }

    syncLibraryLayout();
    narrowLayout.addEventListener('change', syncLibraryLayout);
    libraryToggle.addEventListener('click', () => setLibraryOpen(true));
    document.querySelector('#library-close').addEventListener('click', closeLibrary);
    document.querySelector('#add-music').addEventListener('click', () => fileUpload.click());
    songSearch.addEventListener('input', filterSongs);
    songSearch.addEventListener('keydown', (event) => {
        if (event.key.startsWith('Arrow')) event.stopPropagation();
    });
    clearSongSearch.addEventListener('click', () => {
        songSearch.value = '';
        filterSongs();
        songSearch.focus();
    });
    library.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeLibrary();
    });
    library.addEventListener('click', (event) => {
        if (!narrowLayout.matches || event.target !== library) return;
        var bounds = library.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX >= bounds.right ||
            event.clientY < bounds.top || event.clientY >= bounds.bottom) {
            closeLibrary();
        }
    });
    settingsToggle.addEventListener('click', () => setSettingsOpen(settings.hidden));
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !settings.hidden) {
            setSettingsOpen(false);
            settingsToggle.focus();
        }
    });

    var audioDiv = document.querySelector('.audio-container');

    function clearButtonState(button) {
        if (!button) return;
        button.removeAttribute('aria-current');
        button.removeAttribute('data-playing');
        button.removeAttribute('aria-description');
    }

    function refreshPlayingState(session) {
        if (!session || session.disposed || session !== activeSession) return;
        var audio = session.audio;
        if (!audio) return;
        var playing = !audio.paused && !audio.ended && !audio.error && audio.readyState >= 2;
        if (!session.button) return;
        if (playing) {
            session.button.setAttribute('data-playing', '');
            session.button.setAttribute('aria-description', 'Playing');
        } else {
            session.button.removeAttribute('data-playing');
            session.button.removeAttribute('aria-description');
        }
    }

    function applySelectedButton(session, button) {
        if (!session || session.disposed) return;
        if (session.button && session.button !== button) clearButtonState(session.button);
        session.button = button || null;
        if (session.button) session.button.setAttribute('aria-current', 'true');
        refreshPlayingState(session);
    }

    function listen(session, target, type, handler) {
        target.addEventListener(type, handler);
        session.listeners.push([target, type, handler]);
    }

    function disposeMaterial(material) {
        if (!material) return;
        if (Array.isArray(material)) {
            material.forEach(disposeMaterial);
            return;
        }
        if (typeof material.dispose === 'function') material.dispose();
    }

    // Tears down everything owned by a session: animation loop, Web Audio
    // nodes, media element, canvas/WebGL context, scene resources and GUI.
    function disposeSession(session) {
        if (!session || session.disposed) return;
        session.disposed = true;

        if (session.frameId) {
            cancelAnimationFrame(session.frameId);
            session.frameId = 0;
        }

        clearButtonState(session.button);
        session.button = null;

        if (session.controls) {
            try { session.controls.dispose(); } catch (error) { }
            session.controls = null;
        }

        if (session.gui) {
            try { session.gui.destroy(); } catch (error) { }
            if (session.gui.domElement && session.gui.domElement.parentNode) {
                session.gui.domElement.parentNode.removeChild(session.gui.domElement);
            }
            session.gui = null;
        }

        // Stop listening before mutating the element, so teardown cannot
        // re-enter the state handlers.
        for (const entry of session.listeners) {
            entry[0].removeEventListener(entry[1], entry[2]);
        }
        session.listeners = [];

        if (session.audio) {
            try { session.audio.pause(); } catch (error) { }
            session.audio.removeAttribute('src');
            try { session.audio.load(); } catch (error) { }
            if (session.audio.parentNode) session.audio.parentNode.removeChild(session.audio);
            session.audio = null;
        }

        if (session.source) {
            try { session.source.disconnect(); } catch (error) { }
            session.source = null;
        }
        if (session.analyser) {
            try { session.analyser.disconnect(); } catch (error) { }
            session.analyser = null;
        }

        if (session.objectUrl) {
            URL.revokeObjectURL(session.objectUrl);
            session.objectUrl = null;
        }

        if (session.scene) {
            // Geometries and materials are shared between thousands of
            // meshes, so dispose each resource exactly once.
            var geometries = new Set();
            var materials = new Set();
            session.scene.traverse(function (object) {
                if (object.geometry && typeof object.geometry.dispose === 'function') {
                    geometries.add(object.geometry);
                }
                if (Array.isArray(object.material)) {
                    object.material.forEach(function (material) {
                        if (material) materials.add(material);
                    });
                } else if (object.material) {
                    materials.add(object.material);
                }
            });
            geometries.forEach(function (geometry) { geometry.dispose(); });
            materials.forEach(disposeMaterial);
            while (session.scene.children.length) {
                session.scene.remove(session.scene.children[0]);
            }
            session.scene = null;
        }

        if (session.renderer) {
            try { session.renderer.dispose(); } catch (error) { }
            try {
                if (typeof session.renderer.forceContextLoss === 'function') {
                    session.renderer.forceContextLoss();
                }
            } catch (error) { }
            if (session.renderer.domElement && session.renderer.domElement.parentNode) {
                session.renderer.domElement.parentNode.removeChild(session.renderer.domElement);
            }
            session.renderer = null;
        }

        if (activeSession === session) activeSession = null;
    }

    function resolveDownloadUrl(snapshot) {
        if (!snapshot) return Promise.reject(new Error('Upload completed without a snapshot'));
        if (snapshot.downloadURL) return Promise.resolve(snapshot.downloadURL);
        if (snapshot.ref && typeof snapshot.ref.getDownloadURL === 'function') {
            return Promise.resolve(snapshot.ref.getDownloadURL());
        }
        return Promise.reject(new Error('Upload completed without a download URL'));
    }

    function reportUploadFailure(file, error) {
        console.error('Could not save the uploaded song to the shared library.', error);
        reportStatus('Upload failed: "' + file.name +
            '" could not be saved to the shared library. You can still play it from this device.', 'error');
    }

    // Persists an uploaded file to Firebase. This is deliberately independent
    // from the playback session: a library failure must never tear down or
    // delay the local session that is already playing.
    function uploadSong(file) {
        if (!firebaseReady || !storageRef) {
            reportUploadFailure(file, new Error('Firebase is unavailable'));
            return;
        }

        var songRef;
        try {
            songRef = storageRef.child(file.name);
        } catch (error) {
            reportUploadFailure(file, error);
            return;
        }

        var putResult;
        try {
            putResult = songRef.put(file);
        } catch (error) {
            reportUploadFailure(file, error);
            return;
        }

        Promise.resolve(putResult)
            .then(resolveDownloadUrl)
            .then(function (downloadUrl) {
                var songKey = file.name.replace(/\.[^.]+$/, '') || file.name;
                return Promise.resolve(firebase.database().ref().child('songs').child(songKey).set(downloadUrl));
            })
            .then(function () {
                reportStatus('"' + file.name + '" was added to the shared library.', 'success');
            })
            .catch(function (error) {
                reportUploadFailure(file, error);
            });
    }

    // The single entry point for "start playing this song". Both library
    // selections and local uploads call it, so both get identical teardown
    // and setup semantics.
    function startPlaybackSession(options) {
        var session = {
            id: ++sessionCount,
            name: options.name,
            url: options.url,
            objectUrl: options.objectUrl || null,
            button: null,
            audio: null,
            source: null,
            analyser: null,
            renderer: null,
            scene: null,
            controls: null,
            gui: null,
            resize: null,
            frameId: 0,
            listeners: [],
            disposed: false
        };

        disposeSession(activeSession);

        // Defensive: any canvas that survived an earlier failure is not part
        // of the new session and must not keep rendering alongside it.
        document.querySelectorAll('body > canvas').forEach(function (canvas) {
            canvas.remove();
        });

        activeSession = session;
        trackTitle.textContent = trackTitle.title = options.name;

        // Audio element + analyser are created per session. A fresh media
        // element is required because createMediaElementSource() can only be
        // called once per element, and it guarantees the old element's audio
        // graph can be disconnected and dropped cleanly.
        var audioPlayer = new Audio();
        audioPlayer.crossOrigin = 'anonymous';
        audioPlayer.controls = true;
        audioPlayer.preload = 'auto';
        audioPlayer.src = options.url;
        audioDiv.replaceChildren(audioPlayer);
        session.audio = audioPlayer;

        function onPlay() {
            if (session.disposed || activeSession !== session) return;
            if (audioCtx.state === 'suspended') audioCtx.resume();
            refreshPlayingState(session);
        }
        function onStateChange() {
            refreshPlayingState(session);
        }
        listen(session, audioPlayer, 'play', onPlay);
        for (const event of ['playing', 'pause', 'ended', 'emptied', 'waiting', 'seeked', 'canplay', 'error']) {
            listen(session, audioPlayer, event, onStateChange);
        }

        var analyser;
        var source;
        try {
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            source = audioCtx.createMediaElementSource(audioPlayer);
            source.connect(analyser);
            analyser.connect(audioCtx.destination);
        } catch (error) {
            disposeSession(session);
            reportStatus('This track could not be played: ' +
                (error && error.message ? error.message : error), 'error');
            return;
        }
        session.analyser = analyser;
        session.source = source;

        var dataArray = new Uint8Array(analyser.frequencyBinCount);

        if (options.button) {
            applySelectedButton(session, options.button);
        } else {
            refreshPlayingState(session);
        }

        //Scene Details
        var scene = new THREE.Scene(); //new scene instance
        scene.background = new THREE.Color(0x000000);
        scene.fog = new THREE.FogExp2(0xcccccc, 0.002);
        session.scene = scene;

        var renderer;
        try {
            renderer = new THREE.WebGLRenderer();
        } catch (error) {
            disposeSession(session);
            reportStatus('Visualizer failed to start: ' + (error && error.message ? error.message : error), 'error');
            return;
        }
        session.renderer = renderer;
        document.body.appendChild(renderer.domElement);

        //Lighting Details
        var light = new THREE.AmbientLight(0x505050);
        scene.add(light);
        var directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
        directionalLight.position.set(0, 1, 1);
        scene.add(directionalLight);

        directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
        directionalLight.position.set(1, 1, 0);
        scene.add(directionalLight);


        directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
        directionalLight.position.set(0, -1, -1);
        scene.add(directionalLight);

        directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
        directionalLight.position.set(-1, -1, 0);
        scene.add(directionalLight);

        //Camera Details
        var camera = new THREE.PerspectiveCamera(65, 1, 1, 1000);
        camera.position.x = 32;
        camera.position.y = 50;
        camera.position.z = 50;
        camera.lookAt(scene.position);

        session.resize = function () {
            var width = document.body.clientWidth;
            var height = document.body.clientHeight;
            if (!width || !height) return;
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            renderer.setSize(width, height, false);
        };
        session.resize();

        //Controls Details
        var controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.autoRotate = false;
        session.controls = controls;

        var gui = new dat.GUI({ autoPlace: false, width: 262 });
        session.gui = gui;
        settings.replaceChildren(gui.domElement);

        var f1 = gui.addFolder('Camera')
        f1.add(controls, 'autoRotate', false, true)
        f1.add(controls, 'autoRotateSpeed', 0, 10).step(0.5)
        f1.add(camera.position, 'x', -500, 500).step(5)
        f1.add(camera.position, 'y', -500, 500).step(5)
        f1.add(camera.position, 'z', -500, 500).step(5)
        f1.open()


        //Cubes Details
        var cubes = new Array();
        var cubeGeometry = new THREE.CubeGeometry(1.5, 1.5, 1.5)
        var cubeMaterial = new THREE.MeshPhongMaterial({
            color: (Math.random() * 0xffffff),
            flatShading: false,
            specular: 0xffffff,
            shininess: 14,
            reflectivity: 2,
            fog: false
        });

        var i = 0;
        for (var x = 0; x <= 256; x += 2) {
            var j = 0;
            cubes[i] = new Array();
            for (var y = 0; y <= 62; y += 2) {
                cubes[i][j] = new THREE.Mesh(cubeGeometry, cubeMaterial);
                cubes[i][j].position.x = (y - 30);
                cubes[i][j].position.y = (0);
                cubes[i][j].position.z = (x);
                scene.add(cubes[i][j])
                j++;
            }
            i++;
        }

        //BackgroundShapes Details
        var asteroidMesh = new Array()
        var asteroidGeometry = new THREE.TetrahedronGeometry((Math.random() + 0.5), 2);
        var asteroidMaterial = new THREE.MeshPhongMaterial({
            color: (Math.random() * 0xffffff),
            flatShading: true
        });

        var i = 0;
        for (var x = 0; x < 1; x++) {
            var j = 0;
            asteroidMesh[i] = new Array();
            for (var y = 0; y < 1000; y++) {
                asteroidMesh[i][j] = new THREE.Mesh(asteroidGeometry, asteroidMaterial);
                asteroidMesh[i][j].position.x = (Math.random() - 0.5) * 300;
                asteroidMesh[i][j].position.y = (Math.random() - 0.5) * 300;
                asteroidMesh[i][j].position.z = (Math.random() - 0.5) * 300;
                asteroidMesh[i][j].scale.z = (Math.random() * 2, Math.random() * 2, Math.random() * 2);
                asteroidMesh[i][j].rotation.set(Math.random() * 4, Math.random() * 4, Math.random() * 4)
                scene.add(asteroidMesh[x][j])
                j++;
            }
            i++;
        }

        function animate() {
            // Both guards matter: a cancelled frame should never fire, and a
            // frame that was already queued must not touch a superseded scene.
            if (session.disposed || activeSession !== session) return;
            session.frameId = requestAnimationFrame(animate) //better than set interval because it pauses when user leaves the page
            analyser.getByteFrequencyData(dataArray)
            controls.update();

            var k = 0;
            for (var i = 0; i < cubes.length; i++) {
                for (var j = 0; j < cubes[i].length; j++) {
                    var scale = dataArray[k] / 10;
                    cubes[i][j].scale.y = (scale < 1 ? 1 : scale);
                    k += (k < dataArray.length ? 1 : 0);
                }
            }

            var k = 0;
            for (var i = 0; i < asteroidMesh.length; i++) {
                for (var j = 0; j < asteroidMesh[i].length; j++) {
                    asteroidMesh[i][j].rotation.z += 0.02;
                }
            }
            renderer.render(scene, camera)
        }
        session.frameId = requestAnimationFrame(animate) //gets called 60x per sec to render scene

        if (options.autoplay !== false) {
            var playResult = audioPlayer.play();
            if (playResult && typeof playResult.catch === 'function') {
                playResult.catch(function (error) {
                    // Autoplay may be blocked; the native controls still work.
                    if (session.disposed || activeSession !== session) return;
                    if (error && error.name === 'AbortError') return;
                    console.warn('Playback did not start automatically.', error);
                });
            }
        }
    }

    function resizeActiveSession() {
        if (activeSession && activeSession.resize) activeSession.resize();
    }

    if (window.ResizeObserver) {
        new ResizeObserver(resizeActiveSession).observe(document.body);
    } else {
        window.addEventListener('resize', resizeActiveSession);
    }

    unlockAudioContext(audioCtx);

    function onSongAdded(snapshot) {
        var songUrl = snapshot.val();
        if (!songUrl) return;
        var songKey = snapshot.key || getSongFilename(songUrl);
        var item = document.createElement('li');
        var button = document.createElement('button');
        item.dataset.searchText = (songKey + '\n' + getSongFilename(songUrl)).toLowerCase();
        item.hidden = !item.dataset.searchText.includes(searchQuery);
        button.type = 'button';
        button.textContent = button.title = songKey;
        button.dataset.songUrl = songUrl;
        button.addEventListener('click', function () {
            startPlaybackSession({ name: songKey, url: songUrl, button: button, autoplay: true });
            if (narrowLayout.matches) closeLibrary();
        });
        item.appendChild(button);
        prevSongs.appendChild(item);
        if (searchQuery) updateSearchResults();

        // The default track may already be playing when its library entry
        // arrives; adopt the button so the playing indicator has a target.
        if (activeSession && !activeSession.button && activeSession.url === songUrl) {
            applySelectedButton(activeSession, button);
        }
    }

    //Searches for and loads previous songs uploaded to firebase
    if (firebaseReady) {
        try {
            storageRef = firebase.storage().ref();
            var dbRoot = firebase.database().ref();
            songsRef = dbRoot.child('songs');
            songsRef.on('child_added', onSongAdded);
        } catch (error) {
            firebaseReady = false;
            storageRef = null;
            songsRef = null;
            console.error('The shared song library is unavailable.', error);
        }
    }

    fileUpload.addEventListener('change', function (event) {
        var file = event.target.files && event.target.files[0];
        // Reset immediately so picking the same file again (for example after
        // a failed upload) still fires a change event.
        event.target.value = '';
        if (!file) return;

        //Creates a temporary url for the file that was uploaded so that it could be played the audio element
        var localUrl = URL.createObjectURL(file);
        startPlaybackSession({ name: file.name, url: localUrl, objectUrl: localUrl, autoplay: true });
        if (narrowLayout.matches) closeLibrary();

        //Uploads Song to firebase in the background; playback is local.
        uploadSong(file);
    });

    startPlaybackSession({ name: defaultSongName, url: defaultSong, autoplay: false });
}

function unlockAudioContext(audioCtx) {
    if (audioCtx.state !== 'suspended') return;
    var b = document.body;
    var events = ['touchstart', 'touchend', 'mousedown', 'keydown'];
    function unlock() {
        audioCtx.resume();
        clean();
    }
    function clean() {
        events.forEach(function (event) {
            b.removeEventListener(event, unlock);
        });
    }
    events.forEach(function (event) {
        b.addEventListener(event, unlock, false);
    });
}
