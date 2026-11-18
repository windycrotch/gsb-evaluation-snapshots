var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
var analyser = audioCtx.createAnalyser();
var gui;
var resizeVisualizer;
var defaultSong = "https://firebasestorage.googleapis.com/v0/b/kantelabs-threejs.appspot.com/o/03%20-%20Smooth%20Operator.mp3?alt=media&token=27e95f4c-b4fb-4160-9bdc-02833cf65a84";

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

    // The visualizer is built once and reused for every track. These keep track
    // of the one audio element / MediaElementSource currently feeding analyser.
    var audioDiv = document.querySelector('.audio-container');
    var audioPlayer = null;
    var currentSource = null;
    var currentObjectUrl = null;
    var totalSourcesCreated = 0;

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

    unlockAudioContext(audioCtx);

    // The scene, analyser wiring and requestAnimationFrame loop are created once.
    // Only the media element source is swapped when the track changes.
    analyser.fftSize = 256; // 256 for analyser.getByteFrequencyData(dataArray) and 2048 for analyser.getByteTimeDomainData(dataArray)
    var bufferLength = analyser.frequencyBinCount;
    var dataArray = new Uint8Array(bufferLength)
    console.log(bufferLength)
    buildVisualizer(analyser, dataArray);

    if (window.ResizeObserver) {
        new ResizeObserver(() => resizeVisualizer()).observe(document.body);
    }
    window.addEventListener('resize', () => resizeVisualizer());

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
            switchToTrack(snapshot.key, songUrl, button, null);
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
        if (!selectedSong || selectedSong !== getCurrentSongButton()) return;
        const playing = !audioPlayer.paused && !audioPlayer.ended && !audioPlayer.error &&
            audioPlayer.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
        selectedSong.toggleAttribute('data-playing', playing);
        if (playing) {
            selectedSong.setAttribute('aria-description', 'Playing');
        } else {
            selectedSong.removeAttribute('aria-description');
        }
    }

    function getCurrentSongButton() {
        return selectedSong && selectedSong.isConnected ? selectedSong : null;
    }

    function selectSong(button) {
        // The playing marker may only ever live on the current track's button.
        for (const marked of prevSongs.querySelectorAll('[data-playing]')) {
            marked.removeAttribute('data-playing');
            marked.removeAttribute('aria-description');
        }
        if (selectedSong) {
            selectedSong.removeAttribute('aria-current');
            selectedSong.removeAttribute('data-playing');
            selectedSong.removeAttribute('aria-description');
        }
        selectedSong = button || null;
        if (selectedSong) {
            selectedSong.setAttribute('aria-current', 'true');
            updatePlayingIndicator();
        }
    }

    function disconnectCurrentSource() {
        // Tear down the previous audio path completely so only the new track
        // can reach the analyser: stop the element, cut every Web Audio
        // connection it owns, release its object URL and remove it from the DOM.
        if (audioPlayer) {
            audioPlayer.pause();
            audioPlayer.removeAttribute('src');
            audioPlayer.load();
            for (const event of ['play', 'playing', 'pause', 'ended', 'emptied', 'waiting', 'seeked', 'error']) {
                audioPlayer.removeEventListener(event, updatePlayingIndicator);
            }
        }
        if (currentSource) {
            try {
                currentSource.disconnect();
            } catch (e) {
                console.log(e);
            }
            currentSource = null;
        }
        if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl);
            currentObjectUrl = null;
        }
        if (audioPlayer && audioPlayer.isConnected) {
            audioPlayer.remove();
        }
        audioPlayer = null;
    }

    function connectTrack(name, url, button, objectUrl) {
        var player = new Audio(url);
        player.crossOrigin = "anonymous";
        player.controls = true;

        // One MediaElementAudioSourceNode per audio element. The previous one
        // was disconnected above, so the analyser keeps exactly one active source.
        var source = audioCtx.createMediaElementSource(player);
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        totalSourcesCreated++;

        player.addEventListener('play', () => audioCtx.resume());
        for (const event of ['playing', 'pause', 'ended', 'emptied', 'waiting', 'seeked', 'error']) {
            player.addEventListener(event, updatePlayingIndicator);
        }

        audioDiv.replaceChildren(player);

        audioPlayer = player;
        currentSource = source;
        currentObjectUrl = objectUrl || null;
        currentSongUrl = url;
        trackTitle.textContent = trackTitle.title = name;
        selectSong(button);
    }

    function switchToTrack(name, url, button, objectUrl) {
        disconnectCurrentSource();
        connectTrack(name, url, button, objectUrl);
    }

    fileUpload.onchange = (event) => {
        var file = event.target.files[0];
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
        switchToTrack(songName, objectUrl, null, objectUrl);
        // Resetting the input makes selecting the same file again fire onchange,
        // while switchToTrack still tears down the previous element/source first.
        fileUpload.value = '';
        if (narrowLayout.matches) closeLibrary();
    }

    // Start with the built-in default song. Its button (if any) is marked once
    // the Firebase library list arrives.
    connectTrack(trackTitle.textContent, defaultSong, null, null);

    // Read-only hooks used by the local acceptance page (tests/acceptance.html).
    window.__musicVisualizer = {
        get activeSourceCount() {
            return currentSource ? 1 : 0;
        },
        get totalSourcesCreated() {
            return totalSourcesCreated;
        },
        get currentSourceConnected() {
            return !!currentSource;
        },
        get audioElementCount() {
            return audioDiv.querySelectorAll('audio').length;
        },
        get selectedSongName() {
            return selectedSong ? selectedSong.textContent : null;
        },
        get audioPlayer() {
            return audioPlayer;
        },
        get playingMarkerCount() {
            return prevSongs.querySelectorAll('button[data-playing]').length;
        },
        get playingMarkerOnSelected() {
            return selectedSong ? selectedSong.hasAttribute('data-playing') : false;
        },
        get cameraAspect() {
            return resizeVisualizer._camera ? resizeVisualizer._camera.aspect : null;
        },
        get canvas() {
            return document.querySelector('canvas');
        },
        get narrowLayout() {
            return narrowLayout;
        },
        get library() {
            return library;
        },
        get settings() {
            return settings;
        }
    };
}

function buildVisualizer(analyser, dataArray) {
    //Scene Details
    var scene = new THREE.Scene(); //new scene instance
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.FogExp2(0xcccccc, 0.002);

    var renderer = new THREE.WebGLRenderer();
    document.body.appendChild(renderer.domElement)

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
        // Keep the drawing buffer, renderer size and camera aspect ratio all in
        // sync with the actual viewport (including device pixel ratio).
        var width = window.innerWidth || document.body.clientWidth;
        var height = window.innerHeight || document.body.clientHeight;
        var pixelRatio = window.devicePixelRatio || 1;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(pixelRatio);
        renderer.setSize(width, height, false);
    };
    resizeVisualizer._camera = camera;
    resizeVisualizer();

    //Controls Details
    var controls;
    controls = new THREE.OrbitControls(camera, document.querySelector('canvas'));
    controls.autoRotate = false;

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
        requestAnimationFrame(animate) //better than set interval because it pauses when user leaves the page
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
