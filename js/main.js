var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
var analyser = audioCtx.createAnalyser();
analyser.fftSize = 256; // 256 for analyser.getByteFrequencyData(dataArray) and 2048 for analyser.getByteTimeDomainData(dataArray)
analyser.connect(audioCtx.destination); // single shared output chain, connected exactly once
var gui;
var resizeVisualizer = function () {};
var defaultSong = "https://firebasestorage.googleapis.com/v0/b/kantelabs-threejs.appspot.com/o/03%20-%20Smooth%20Operator.mp3?alt=media&token=27e95f4c-b4fb-4160-9bdc-02833cf65a84";

// ---------------------------------------------------------------------------
// Track-switching lifecycle state.
// activeSession describes the one and only live track: its <audio> element,
// its MediaElementSource node, its renderer/canvas and its animation frame.
// Every switch tears the previous session down before building the next one,
// so there is never more than one analysis chain, one canvas or one rAF loop.
// ---------------------------------------------------------------------------
var activeSession = null;
var switchToken = 0; // monotonic token: only the latest selection may take effect

function disposeSceneGraph(scene) {
    scene.traverse(function (obj) {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
            var materials = Array.isArray(obj.material) ? obj.material : [obj.material];
            materials.forEach(function (m) { m.dispose(); });
        }
    });
}

// Stop rendering + silence + detach everything belonging to a session.
// keepPlayer: leave the <audio> element in the DOM (used on load failure so
// the user keeps a working player and can pick another track).
function teardownSession(session, keepPlayer) {
    if (!session) return;

    // 1. Stop the animation loop (id + stale-loop guard in animate()).
    if (session.rafId) cancelAnimationFrame(session.rafId);
    session.rafId = 0;
    session.tornDown = true;

    // 2. Disconnect the old analysis node from the analyser/speakers.
    if (session.source) {
        try { session.source.disconnect(); } catch (e) { /* already disconnected */ }
        session.source = null;
    }

    // 3. Silence and remove the old audio element so it cannot keep playing.
    if (session.audioPlayer && !keepPlayer) {
        session.audioPlayer.pause();
        session.audioPlayer.removeAttribute('src');
        session.audioPlayer.load(); // abort any in-flight fetch/decode
        if (session.audioPlayer.parentNode) {
            session.audioPlayer.parentNode.removeChild(session.audioPlayer);
        }
    }

    // 4. Release the temporary object URL, if any.
    if (session.objectUrl && !keepPlayer) {
        URL.revokeObjectURL(session.objectUrl);
        session.objectUrl = null;
    }

    // 5. Truly remove the old canvas and free its GL resources.
    if (session.renderer) {
        if (session.controls && typeof session.controls.dispose === 'function') {
            session.controls.dispose();
        }
        if (session.scene) disposeSceneGraph(session.scene);
        session.renderer.dispose();
        if (session.renderer.domElement.parentNode) {
            session.renderer.domElement.parentNode.removeChild(session.renderer.domElement);
        }
        session.renderer = null;
        session.scene = null;
    }

    resizeVisualizer = function () {};
}

function teardownActiveSession() {
    if (!activeSession) return;
    var session = activeSession;
    activeSession = null;
    teardownSession(session, false);
}

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
    var narrowLayout = window.matchMedia('(max-width: 700px)');
    var selectedSong;
    var currentSongUrl = defaultSong;
    var searchQuery = '';

    function getSongFilename(url) {
        try {
            return decodeURIComponent(new URL(url, document.baseURI).pathname).split('/').pop();
        } catch {
            return '';
        }
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
        if (open && narrowLayout.matches) {
            setSettingsOpen(false);
            library.showModal();
        } else if (open) {
            library.show();
        } else {
            library.close();
        }
        libraryToggle.hidden = library.open;
        libraryToggle.setAttribute('aria-expanded', String(library.open));
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

    var storageRef = firebase.storage().ref();
    var dbRoot = firebase.database().ref();
    var songsRef = dbRoot.child('songs');
    var audioDiv = document.querySelector('.audio-container');

    unlockAudioContext(audioCtx);

    if (window.ResizeObserver) {
        new ResizeObserver(() => resizeVisualizer()).observe(document.body);
    } else {
        window.addEventListener('resize', () => resizeVisualizer());
    }

    // -----------------------------------------------------------------------
    // The single entry point for every track change (library pick, upload,
    // initial load). Tears down the previous session completely, then builds
    // exactly one new analysis chain for the new track. Rapid consecutive
    // switches are serialized by the switch token: only the latest selection
    // survives, earlier ones leave no animation frames or audio nodes behind.
    // -----------------------------------------------------------------------
    function startTrack(name, url, button, objectUrl) {
        var token = ++switchToken;

        // Wipe the previous track: rAF loop, source node, <audio>, canvas.
        teardownActiveSession();
        audioDiv.replaceChildren();

        // Fresh <audio> element per track (a MediaElementSource can only be
        // created once per element, so reusing elements is not an option).
        var player = new Audio();
        player.crossOrigin = "anonymous";
        player.controls = true;
        player.src = url;
        audioDiv.appendChild(player);

        var session = {
            token: token,
            audioPlayer: player,
            objectUrl: objectUrl || null,
            source: null,
            renderer: null,
            scene: null,
            controls: null,
            rafId: 0,
            tornDown: false
        };
        activeSession = session;

        player.addEventListener('play', () => audioCtx.resume());
        for (const event of ['playing', 'pause', 'ended', 'emptied', 'waiting', 'seeked', 'error']) {
            player.addEventListener(event, updatePlayingIndicator);
        }
        player.addEventListener('error', () => {
            // A stale session's error must not touch the current track.
            if (session !== activeSession || session.tornDown) return;
            // Load failed: tear down the half-built analysis/visual chain but
            // keep the player element so the UI stays operable and the user
            // can simply pick another track.
            teardownSession(session, true);
        });

        // Sync title / selection / controls with the new track.
        setCurrentTrack(name, url, button);

        try {
            analyzeAudio(session);
        } catch (err) {
            console.error('Failed to start visualizer for', name, err);
            if (session === activeSession) teardownSession(session, true);
        }
    }

    //Searches for and loads previous songs uploaded to firebase
    songsRef.on('child_added', snapshot => {
        const songUrl = snapshot.val();
        const item = document.createElement('li');
        const button = document.createElement('button');
        item.dataset.searchText = (snapshot.key + '\n' + getSongFilename(songUrl)).toLowerCase();
        item.hidden = !item.dataset.searchText.includes(searchQuery);
        button.type = 'button';
        button.textContent = button.title = snapshot.key;
        button.addEventListener('click', () => {
            startTrack(snapshot.key, songUrl, button);
            if (narrowLayout.matches) closeLibrary();
        });
        item.appendChild(button);
        prevSongs.appendChild(item);
        if (searchQuery) updateSearchResults();
        if (songUrl === currentSongUrl && !selectedSong) {
            selectSong(button);
        }
    });

    function updatePlayingIndicator() {
        if (!selectedSong) return;
        var player = activeSession && activeSession.audioPlayer;
        const playing = !!player && !player.paused && !player.ended && !player.error &&
            player.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
        selectedSong.toggleAttribute('data-playing', playing);
        if (playing) {
            selectedSong.setAttribute('aria-description', 'Playing');
        } else {
            selectedSong.removeAttribute('aria-description');
        }
    }

    function selectSong(button) {
        if (selectedSong) {
            selectedSong.removeAttribute('aria-current');
            selectedSong.removeAttribute('data-playing');
            selectedSong.removeAttribute('aria-description');
        }
        selectedSong = button;
        if (selectedSong) {
            selectedSong.setAttribute('aria-current', 'true');
            updatePlayingIndicator();
        }
    }

    function setCurrentTrack(name, url, button) {
        trackTitle.textContent = trackTitle.title = name;
        currentSongUrl = url;
        selectSong(button);
    }

    fileUpload.onchange = (event) => {
        var file = event.target.files[0];
        // Allow picking the same file again later (re-select must re-trigger).
        event.target.value = '';
        if (!file) return;
        var songName = file.name;

        //Uploads Song to firebase
        var songRef = storageRef.child(songName)
        songRef.put(file).then(function (snapshot) {
            let dlUrl = snapshot.downloadURL;
            databaseRef = firebase.database().ref().child('songs').child(songName.split('.').slice(0, 1).join(' '))
            databaseRef.set(dlUrl)
            console.log("uploaded song");
        })
            .then(res => (console.log(res)))
            .catch(err => console.log(err))

        //Creates a temporary url for the file that was uploaded so that it could be played the audio element
        var objectUrl = URL.createObjectURL(file);
        startTrack(songName, objectUrl, null, objectUrl);
        if (narrowLayout.matches) closeLibrary();
    }

    // Initial track.
    startTrack('Smooth Operator', defaultSong, null);
}

function analyzeAudio(session) {
    // AnalyserNode is necessary to provide real-time frequency and time-domain analysis information. It is an AudioNode that passes the audio stream unchanged from the input to the output, but allows you to take the generated data, process it, and create audio visualizations.

    // Exactly one source -> analyser -> destination chain per track.
    var source = audioCtx.createMediaElementSource(session.audioPlayer);
    source.connect(analyser);
    session.source = source;

    var bufferLength = analyser.frequencyBinCount;
    var dataArray = new Uint8Array(bufferLength)
    console.log(bufferLength)

    //Scene Details
    var scene = new THREE.Scene(); //new scene instance
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.FogExp2(0xcccccc, 0.002);
    session.scene = scene;

    var renderer = new THREE.WebGLRenderer();
    session.renderer = renderer;
    // Defensive: the old canvas was already removed by teardownSession; make
    // sure no stray canvas can survive before attaching the new one.
    var strayCanvas = document.querySelector('canvas');
    if (strayCanvas) strayCanvas.remove();
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

    resizeVisualizer = function () {
        if (session !== activeSession || !session.renderer) return;
        var width = document.body.clientWidth;
        var height = document.body.clientHeight;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
    };
    resizeVisualizer();

    //Controls Details
    var controls;
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.autoRotate = false;
    session.controls = controls;

    if (gui) gui.destroy();
    gui = new dat.GUI({ autoPlace: false, width: 262 });
    document.querySelector('#camera-settings').replaceChildren(gui.domElement);

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
        // Stale-loop guard: a superseded session never renders again, even if
        // its cancelAnimationFrame raced with an already-queued callback.
        if (session !== activeSession || session.tornDown || !session.renderer) return;
        session.rafId = requestAnimationFrame(animate) //better than set interval because it pauses when user leaves the page
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
    animate() //gets called 60x per sec to render scene
}

function unlockAudioContext(audioCtx) {
    if (audioCtx.state !== 'suspended') return;
    const b = document.body;
    const events = ['touchstart', 'touchend', 'mousedown', 'keydown'];
    events.forEach(e => b.addEventListener(e, unlock, false));
    function unlock() { audioCtx.resume() }
    function clean() { events.forEach(e => b.removeEventListener(e, unlock)); }
}
