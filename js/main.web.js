var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
var analyser = audioCtx.createAnalyser();
analyser.fftSize = 256; // 256 for analyser.getByteFrequencyData(dataArray) and 2048 for analyser.getByteTimeDomainData(dataArray)
analyser.connect(audioCtx.destination); // single shared output chain, connected once

// Lifecycle state for the currently active track. Every new upload tears the
// previous session down (animation frame, source node, <audio>, canvas)
// before building the next one, so only one analysis chain ever exists.
var activeSession = null;
var switchToken = 0;

function teardownActiveSession(keepPlayer) {
    if (!activeSession) return;
    var session = activeSession;
    activeSession = null;

    // 1. Stop the previous animation loop.
    if (session.rafId) cancelAnimationFrame(session.rafId);
    session.tornDown = true;

    // 1b. Kill tweens still animating the old scene so TweenLite's ticker
    // goes idle instead of mutating a torn-down scene forever.
    if (session.tweenTargets && window.TweenLite) {
        session.tweenTargets.forEach(function (t) { TweenLite.killTweensOf(t); });
        session.tweenTargets = null;
    }

    // 2. Disconnect the old analysis node from the analyser/speakers.
    if (session.source) {
        try { session.source.disconnect(); } catch (e) { /* already disconnected */ }
    }

    // 3. Silence and remove the old audio element so it cannot keep playing.
    if (session.audioPlayer && !keepPlayer) {
        session.audioPlayer.pause();
        session.audioPlayer.removeAttribute('src');
        session.audioPlayer.load();
        if (session.audioPlayer.parentNode) session.audioPlayer.parentNode.removeChild(session.audioPlayer);
    }

    // 4. Release the temporary object URL.
    if (session.objectUrl && !keepPlayer) URL.revokeObjectURL(session.objectUrl);

    // 5. Truly remove the old canvas and free its GL resources.
    if (session.renderer) {
        session.renderer.dispose();
        if (session.renderer.domElement.parentNode) {
            session.renderer.domElement.parentNode.removeChild(session.renderer.domElement);
        }
    }
}

window.onload = function () {
    var fileUpload = document.querySelector('#audioFile'); //Grabs the file input and stores it in an variable
    var form = document.querySelector('form');
    var pickedShape = form.elements.sceneShape.value;

    fileUpload.onchange = (event) => {
        var file = event.target.files[0]; // grab the File before clearing the input
        event.target.value = ''; // allow re-selecting the same file
        if (!file) return;
        var songName = file.name;
        console.log(`Now playing ${songName}, with shape ${pickedShape}`)

        var token = ++switchToken;

        // Wipe the previous track: rAF loop, source node, <audio>, canvas.
        teardownActiveSession(false);

        //Creates a temporary url for the file that was uploaded so that it could be played the audio element
        var objectUrl = URL.createObjectURL(file);
        var audioPlayer = new Audio(objectUrl);
        var audioDiv = document.querySelector('.audio-container');
        audioDiv.replaceChildren();
        audioDiv.appendChild(audioPlayer);
        audioPlayer.controls = true;
        audioPlayer.load();
        /*audioPlayer.play(),*/

        var session = {
            token: token,
            audioPlayer: audioPlayer,
            objectUrl: objectUrl,
            source: null,
            renderer: null,
            rafId: 0,
            tornDown: false
        };
        activeSession = session;

        audioPlayer.addEventListener('error', () => {
            // Load failed: drop the half-built chain but keep a usable player.
            if (session !== activeSession || session.tornDown) return;
            teardownActiveSession(true); // keepPlayer: <audio> stays in the DOM
        });

        try {
            analyzeAudio(session);
        } catch (err) {
            console.error('Failed to start visualizer for', songName, err);
            if (session === activeSession) teardownActiveSession(true);
        }
    }

    form.onchange = (event) => {
        console.log(event.target.value)
    }
}

function analyzeAudio(session) {
    // AnalyserNode is necessary to provide real-time frequency and time-domain analysis information. It is an AudioNode that passes the audio stream unchanged from the input to the output, but allows you to take the generated data, process it, and create audio visualizations.

    // Exactly one source -> analyser -> destination chain per track.
    var source = audioCtx.createMediaElementSource(session.audioPlayer) // Uploaded audio becomes the source for the media stream
    source.connect(analyser)
    session.source = source;

    var bufferLength = analyser.frequencyBinCount;
    console.log(bufferLength)
    var dataArray = new Uint8Array(bufferLength)

    //Scene Details
    var scene = new THREE.Scene(); //new scene instance
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.FogExp2(0xcccccc, 0.002);

    var renderer = new THREE.WebGLRenderer();
    session.renderer = renderer;
    renderer.setSize(window.innerWidth, window.innerHeight);
    // Defensive: teardown already removed the old canvas; never allow strays.
    var strayCanvas = document.querySelector('canvas');
    if (strayCanvas) strayCanvas.remove();
    document.body.appendChild(renderer.domElement);

    //Lighting Details
    var light = new THREE.AmbientLight(0x505050);
    scene.add(light);

    var directionalLight1 = new THREE.DirectionalLight(0xffffff, 0.7);
    directionalLight1.position.set(0, 1, 1);
    scene.add(directionalLight1);

    directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.7);
    directionalLight2.position.set(1, 1, 0);
    scene.add(directionalLight2);


    directionalLight3 = new THREE.DirectionalLight(0xffffff, 0.7);
    directionalLight3.position.set(0, -1, -1);
    scene.add(directionalLight3);

    directionalLight4 = new THREE.DirectionalLight(0xffffff, 0.7);
    directionalLight4.position.set(-1, -1, 0);
    scene.add(directionalLight4);

    // TweenLite animates these every frame; tracked so teardown can kill them.
    session.tweenTargets = [directionalLight1, directionalLight2, directionalLight3, directionalLight4];

    //Camera Details
    var camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 1, 1000);
    camera.position.x = 32;
    camera.position.y = 50;
    camera.position.z = 175;
    camera.lookAt(scene.position);
    window.addEventListener('resize', function () {
        if (session !== activeSession || session.tornDown) return;
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();

        renderer.setSize(window.innerWidth, window.innerHeight);

    }, false);

    //Controls Details
    var controls;
    controls = new THREE.OrbitControls(camera);

    //Web Shape Details
    var webGeometry = new THREE.RingGeometry(30, 15, 8, 8, 0, 6.3);
    var webMaterial = new THREE.WireframeGeometry(webGeometry, {
        color: 0x156289,
        emissive: 0x072534,
        side: THREE.DoubleSide,
        flatShading: true,
    });
    var webMesh = new THREE.LineSegments(webMaterial);
    webMesh.material.depthTest = true;
    webMesh.material.transparent = true;
    webMeshBack = webMesh.clone();
    scene.add(webMesh);
    scene.add(webMeshBack);

    //Circle Details
    var circleGeometry = new THREE.SphereGeometry(10, 20, 20);
    var circleMaterial = new THREE.MeshPhongMaterial({ color: 0x000000, flatShading: true });
    var sphere = new THREE.Mesh(circleGeometry, circleMaterial);
    scene.add(sphere)

    // Giant ShellMesh Details
    var shellGeometry = new THREE.SphereGeometry(100, 50, 50);
    var shellMaterial = new THREE.WireframeGeometry(shellGeometry, {
        color: 0xffff00,
        emissive: 0x072534,
        side: THREE.DoubleSide,
        flatShading: false,
    });
    var shellMesh = new THREE.LineSegments(shellMaterial);
    shellMesh.material.depthTest = true;
    shellMesh.material.transparent = true;
    scene.add(shellMesh);

    function animate() {
        // Stale-loop guard: a superseded session never renders again.
        if (session !== activeSession || session.tornDown) return;
        session.rafId = requestAnimationFrame(animate) //better than set interval because it pauses when user leaves the page
        analyser.getByteFrequencyData(dataArray)
        controls.autoRotate = true;
        controls.autoRotateSpeed = 1;
        controls.update();

        sphere.rotation.z += 0.01;

        var k = 0;

        if (dataArray[k]) {
            TweenLite.to(directionalLight1, 1, { intensity: Math.random() * (dataArray[k] / 10 < 1 ? 1 : dataArray[k] / 10) })
            TweenLite.to(directionalLight2, 1, { intensity: Math.random() * (dataArray[k] / 10 < 1 ? 1 : dataArray[k] / 10) })
            TweenLite.to(directionalLight3, 1, { intensity: Math.random() * (dataArray[k] / 10 < 1 ? 1 : dataArray[k] / 10) })
            TweenLite.to(directionalLight4, 1, { intensity: Math.random() * (dataArray[k] / 10 < 1 ? 1 : dataArray[k] / 10) })
        } else {
            null;
        }

        sphere.scale.x = (dataArray[k] / 30 < 1 ? 1.1 : dataArray[k] / 150);
        sphere.scale.y = (dataArray[k] / 30 < 1 ? 1.1 : dataArray[k] / 150);
        sphere.scale.z = (dataArray[k] / 30 < 1 ? 1.1 : dataArray[k] / 150);

        webMeshBack.position.z = -(dataArray[k] / 10 < 1 ? 1 : dataArray[k] / 10)
        webMesh.position.z = (dataArray[k] / 10 < 1 ? 1 : dataArray[k] / 10)
        for (var i = 0; i < dataArray.length; i++) {
            var scale = dataArray[k] / 30;
            k += (k < dataArray.length ? 1 : 0);
        }
        renderer.render(scene, camera)
    }
    animate() //gets called 60x per sec to render scene
}
