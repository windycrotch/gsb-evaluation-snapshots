import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  Raycaster,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  Box3,
  Color,
  Mesh,
  SphereGeometry,
  MeshBasicMaterial,
  BackSide,

  // required for various controls
  EventDispatcher,
  MOUSE,
  Quaternion,
  Spherical,
  Timer
} from 'three';

const three = window.THREE
  ? window.THREE // Prefer consumption from global THREE, if exists
  : {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  Raycaster,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  Box3,
  Color,
  Mesh,
  SphereGeometry,
  MeshBasicMaterial,
  BackSide,

  EventDispatcher,
  MOUSE,
  Quaternion,
  Spherical,
  Timer
};

import { WebGPURenderer } from 'three/webgpu';

import { TrackballControls as ThreeTrackballControls } from 'three/addons/controls/TrackballControls.js';
import { ArcballControls as ThreeArcballControls } from 'three/addons/controls/ArcballControls.js';
import { OrbitControls as ThreeOrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FlyControls as ThreeFlyControls } from 'three/addons/controls/FlyControls.js';

import { EffectComposer as ThreeEffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass as ThreeRenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';

import { parseToRgb, opacify } from 'polished';
import { Tween, Group as TweenGroup, Easing } from '@tweenjs/tween.js';

import accessorFn from 'accessor-fn';
import Kapsule from 'kapsule';
import Tooltip from 'float-tooltip';

import { emptyObject } from './three-gc.js';

const CAMERA_TWEEN_KEYS = ['povPosTween', 'povTgtTween'];

// Stops and detaches any in-flight camera animations, leaving the camera at its current
// (possibly mid-animation) position. Used whenever a newer camera command supersedes them.
const stopCameraTweens = state => {
  CAMERA_TWEEN_KEYS.forEach(key => {
    const tween = state[key];
    if (tween) {
      tween.stop();
      state.tweenGroup.remove(tween);
      state[key] = undefined;
    }
  });
};

// Invalidates any in-flight background image load and drops its pending load callback.
const cancelBackgroundImageRequest = state => {
  state.bgImageRequestId++;

  if (state.bgImageCallbackTimer !== undefined) {
    clearTimeout(state.bgImageCallbackTimer);
    state.bgImageCallbackTimer = undefined;
  }
};

// Releases the currently applied background texture and hides the sky sphere, so no stale
// image can linger after switching or clearing the background image url.
const releaseBackgroundImage = state => {
  const texture = state.bgImageTexture;

  if (state.bgImageMaterial) {
    state.bgImageMaterial.map = null;
    state.bgImageMaterial.needsUpdate = true;
  }

  state.bgImageTexture = undefined;
  texture?.dispose();

  if (state.skysphere) {
    state.skysphere.visible = false;
  }
};

// Marks the (initial) asynchronous loading stage as done and reveals the scene.
const finishLoad = state => {
  state.loadComplete = state.scene.visible = true;
};

// Applies the current backgroundImageUrl, discarding any previous request so that only the
// latest url can take effect. Runs within the scene's update cycle, keeping the background
// image state consistent with the camera and the rest of the render state.
const applyBackgroundImage = state => {
  const url = state.backgroundImageUrl;

  // Invalidate any previous in-flight load and drop its deferred onBackgroundImageLoaded callback
  cancelBackgroundImageRequest(state);

  // A switch or a clear must never leave the previous texture behind
  releaseBackgroundImage(state);

  if (!url) {
    // Clearing the url should never keep the scene hidden forever
    finishLoad(state);
    return;
  }

  const requestId = state.bgImageRequestId;

  new three.TextureLoader().load(
    url,
    texture => {
      if (state.destroyed || requestId !== state.bgImageRequestId) {
        // Superseded by a newer url or destroyed: drop the stale texture instead of applying it
        texture.dispose();
        return;
      }

      texture.colorSpace = three.SRGBColorSpace;

      state.bgImageTexture = texture;
      state.bgImageMaterial.map = texture;
      state.bgImageMaterial.needsUpdate = true;
      state.skysphere.visible = true;

      // triggered when background image finishes loading (async to allow 1 frame to load texture)
      const onLoaded = state.onBackgroundImageLoaded;
      if (onLoaded) {
        state.bgImageCallbackTimer = setTimeout(() => {
          state.bgImageCallbackTimer = undefined;
          if (state.destroyed || requestId !== state.bgImageRequestId) return;
          onLoaded();
        });
      }

      finishLoad(state);
    },
    undefined,
    () => {
      // Load failed: discard the request and make sure the scene is not left hidden forever
      if (state.destroyed || requestId !== state.bgImageRequestId) return;

      releaseBackgroundImage(state);
      finishLoad(state);
    }
  );
};

export default Kapsule({
  props: {
    width: { default: window.innerWidth, onChange(width, state, prevWidth) { isNaN(width) && (state.width = prevWidth) } },
    height: { default: window.innerHeight, onChange(height, state, prevHeight) { isNaN(height) && (state.height = prevHeight) } },
    viewOffset: { default: [0, 0] },
    backgroundColor: { default: '#000011' },
    backgroundImageUrl: {
      onChange(_, state) {
        // Invalidate any in-flight load (and its deferred callback) as soon as a new url is
        // requested, so a slower earlier request can never win against the latest one.
        cancelBackgroundImageRequest(state);
      }
    },
    onBackgroundImageLoaded: {},
    showNavInfo: { default: true },
    skyRadius: { default: 50000 },
    objects: { default: [] },
    lights: { default: [] },
    enablePointerInteraction: {
      default: true,
      onChange(_, state) {
        // Reset hover state
        state.hoverObj = null;
        state.tooltip && state.tooltip.content(null);
      },
      triggerUpdate: false
    },
    pointerRaycasterThrottleMs: { default: 50, triggerUpdate: false },
    lineHoverPrecision: { default: 1, triggerUpdate: false },
    pointsHoverPrecision: { default: 1, triggerUpdate: false },
    hoverOrderComparator: { triggerUpdate: false }, // keep existing order by default
    hoverFilter: { default: () => true, triggerUpdate: false }, // exclude objects from interaction
    tooltipContent: { triggerUpdate: false },
    hoverDuringDrag: { default: false, triggerUpdate: false },
    clickAfterDrag: { default: false, triggerUpdate: false },
    onHover: { default: () => {}, triggerUpdate: false },
    onClick: { default: () => {}, triggerUpdate: false },
    onRightClick: { triggerUpdate: false }
  },

  methods: {
    tick: function(state) {
      if (state.initialised && !state.destroyed) {
        state.controls.enabled && state.controls.update?.(Math.min(1, state.timer.update().getDelta())); // timedelta is required for fly controls

        state.postProcessingComposer
          ? state.postProcessingComposer.render() // if using postprocessing, switch the output to it
          : state.renderer.render(state.scene, state.camera);

        state.extraRenderers.forEach(r => r.render(state.scene, state.camera));

        const now = +new Date();
        if (state.enablePointerInteraction && (now - state.lastRaycasterCheck) >= state.pointerRaycasterThrottleMs) {
          state.lastRaycasterCheck = now;
          // Update tooltip and trigger onHover events
          let topObject = null;
          if (state.hoverDuringDrag || !state.isPointerDragging) {
            const intersects = this.intersectingObjects(state.pointerPos.x, state.pointerPos.y);

            state.hoverOrderComparator && intersects.sort((a, b) => state.hoverOrderComparator(a.object, b.object, a, b));

            const topIntersect = intersects.find(d => state.hoverFilter(d.object)) || null;

            topObject = topIntersect ? topIntersect.object : null;
            state.intersection = topIntersect || null;
          }

          if (topObject !== state.hoverObj) {
            state.onHover(topObject, state.hoverObj, state.intersection);
            state.tooltip.content(topObject ? accessorFn(state.tooltipContent)(topObject, state.intersection) || null : null);
            state.hoverObj = topObject;
          }
        }

        state.tweenGroup.update(); // update camera animation tweens
      }

      return this;
    },
    getPointerPos: function(state) {
      const { x, y } = state.pointerPos;
      return { x, y };
    },
    cameraPosition: function(state, position, lookAt, transitionDuration) {
      const camera = state.camera;

      // Setter
      if (position && state.initialised && !state.destroyed) {
        const finalPos = position;
        const finalLookAt = lookAt || {x: 0, y: 0, z: 0};

        // cancel any ongoing pov animation, without snapping the camera to its destination.
        // The last call wins: older animations must not continue or re-apply their target.
        stopCameraTweens(state);

        if (!transitionDuration) { // no animation
          setCameraPos(finalPos);
          setLookAt(finalLookAt);
        } else {
          const camPos = Object.assign({}, camera.position);
          const camLookAt = getLookAt();

          state.tweenGroup.add(
            state.povPosTween = new Tween(camPos)
              .to(finalPos, transitionDuration)
              .easing(Easing.Quadratic.Out)
              .onUpdate(setCameraPos)
              .onComplete(function() {
                if (state.povPosTween === this) state.povPosTween = undefined;
                state.tweenGroup.remove(this);
              })
              .start()
          );

          // Face direction in 1/3rd of time
          state.tweenGroup.add(
            state.povTgtTween = new Tween(camLookAt)
              .to(finalLookAt, transitionDuration / 3)
              .easing(Easing.Quadratic.Out)
              .onUpdate(setLookAt)
              .onComplete(function() {
                if (state.povTgtTween === this) state.povTgtTween = undefined;
                state.tweenGroup.remove(this);
              })
              .start()
          );
        }

        return this;
      }

      // Getter
      return Object.assign({}, camera.position, { lookAt: getLookAt() });

      //

      function setCameraPos(pos) {
        const { x, y, z } = pos;
        if (x !== undefined) camera.position.x = x;
        if (y !== undefined) camera.position.y = y;
        if (z !== undefined) camera.position.z = z;
      }

      function setLookAt(lookAt) {
        const lookAtVect = new three.Vector3(lookAt.x, lookAt.y, lookAt.z);
        if (state.controls.enabled && state.controls.target) {
          state.controls.target = lookAtVect;
        } else { // Fly controls doesn't have target attribute
          camera.lookAt(lookAtVect); // note: lookAt may be overridden by other controls in some cases
        }
      }

      function getLookAt() {
        return Object.assign(
          (new three.Vector3(0, 0, -1000))
            .applyQuaternion(camera.quaternion)
            .add(camera.position)
        );
      }
    },
    zoomToFit: function (state, transitionDuration = 0, padding = 10, bboxArg, preserveLookDirection) {
      return this.fitToBbox(this.getBbox(bboxArg), transitionDuration, padding, preserveLookDirection);
    },
    fitToBbox: function (state, bbox, transitionDuration = 0, padding = 10, preserveLookDirection = false) {
      const camera = state.camera;

      if (bbox && !state.destroyed) {
        camera.updateMatrixWorld();
        const camRight = new three.Vector3();
        const camUp = new three.Vector3();
        const camForward = new three.Vector3();
        const camPos = new three.Vector3();
        camera.getWorldPosition(camPos);
        camera.getWorldDirection(camForward);
        camRight.crossVectors(camForward, camera.up).normalize();
        camUp.crossVectors(camRight, camForward).normalize();

        const paddedFov = (1 - (padding * 2 / state.height)) * camera.fov;
        const vFovHalf = (paddedFov / 2) * (Math.PI / 180);
        const hFovHalf = Math.atan(Math.tan(vFovHalf) * camera.aspect);

        const bboxCenter = new three.Vector3(
          (bbox.x[0] + bbox.x[1]) / 2,
          (bbox.y[0] + bbox.y[1]) / 2,
          (bbox.z[0] + bbox.z[1]) / 2
        );
        const center = preserveLookDirection
          ? camForward.clone().multiplyScalar(camPos.distanceTo(bboxCenter)).add(camPos)
          : bboxCenter;

        const distance = Math.max(0, ...[
          new three.Vector3(bbox.x[0], bbox.y[0], bbox.z[0]),
          new three.Vector3(bbox.x[0], bbox.y[0], bbox.z[1]),
          new three.Vector3(bbox.x[0], bbox.y[1], bbox.z[0]),
          new three.Vector3(bbox.x[0], bbox.y[1], bbox.z[1]),
          new three.Vector3(bbox.x[1], bbox.y[0], bbox.z[0]),
          new three.Vector3(bbox.x[1], bbox.y[0], bbox.z[1]),
          new three.Vector3(bbox.x[1], bbox.y[1], bbox.z[0]),
          new three.Vector3(bbox.x[1], bbox.y[1], bbox.z[1])
        ].map(corner => {
          const localPos = corner.clone().sub(center);
          return Math.max(
            Math.abs(localPos.dot(camUp)) / Math.tan(vFovHalf),
            Math.abs(localPos.dot(camRight)) / Math.tan(hFovHalf)
          ) - localPos.dot(camForward);
        }));

        const dir = camForward.clone().negate();
        const newCameraPos = {
          x: center.x + dir.x * distance,
          y: center.y + dir.y * distance,
          z: center.z + dir.z * distance
        };

        this.cameraPosition(newCameraPos, center, transitionDuration);
      }

      return this;
    },
    getBbox: function (state, objFilter = () => true) {
      const box = new three.Box3();
      const objs = state.objects.filter(objFilter);

      if (!objs.length) return null;

      objs.forEach(obj => box.expandByObject(obj));

      // extract global x,y,z min/max
      return  Object.assign(...['x', 'y', 'z'].map(c => ({
        [c]: [box.min[c], box.max[c]]
      })));
    },
    getScreenCoords: function(state, x, y, z) {
      const vec = new three.Vector3(x, y, z);
      vec.project(this.camera()); // project to the camera plane
      return { // align relative pos to canvas dimensions
        x: (vec.x + 1) * state.width / 2,
        y: -(vec.y - 1) * state.height / 2,
      };
    },
    getSceneCoords: function(state, screenX, screenY, distance = 0) {
      const relCoords = new three.Vector2(
        (screenX / state.width) * 2 - 1,
        -(screenY / state.height) * 2 + 1
      );

      const raycaster = new three.Raycaster();
      raycaster.setFromCamera(relCoords, state.camera);
      return Object.assign({}, raycaster.ray.at(distance, new three.Vector3()));
    },
    intersectingObjects: function(state, x, y) {
      const relCoords = new three.Vector2(
        (x / state.width) * 2 - 1,
        -(y / state.height) * 2 + 1
      );

      const raycaster = new three.Raycaster();
      raycaster.params.Line.threshold = state.lineHoverPrecision; // set linePrecision
      raycaster.params.Points.threshold = state.pointsHoverPrecision; // set pointsPrecision
      raycaster.setFromCamera(relCoords, state.camera);
      return raycaster.intersectObjects(state.objects, true);
    },
    renderer: state => state.renderer,
    scene: state => state.scene,
    camera: state => state.camera,
    postProcessingComposer: state => state.postProcessingComposer,
    controls: state => state.controls,
    _destructor: function(state) {
      state.destroyed = true;

      // Stop any camera animation and prevent its callbacks from firing post-teardown
      stopCameraTweens(state);
      state.tweenGroup.removeAll();

      // Invalidate in-flight background image loads and pending deferred callbacks
      cancelBackgroundImageRequest(state);
      releaseBackgroundImage(state);

      emptyObject(state.scene);
      state.controls?.dispose();
      state.renderer?.dispose();
      state.postProcessingComposer?.dispose();
    }
  },

  stateInit: () => ({
    scene: new three.Scene(),
    camera: new three.PerspectiveCamera(),
    timer: new three.Timer(),
    tweenGroup: new TweenGroup(),
    lastRaycasterCheck: 0,

    // Background image request bookkeeping. A monotonically increasing id tags each load so
    // that stale (superseded) loads can be recognised and discarded.
    bgImageRequestId: 0,
    bgImageTexture: undefined,
    bgImageCallbackTimer: undefined,
    destroyed: false
  }),

  init(domNode, state, {
    controlType = 'trackball',
    useWebGPU = false,
    rendererConfig = {},
    extraRenderers = [],
    waitForLoadComplete = true
  } = {}) {
    // Wipe DOM
    domNode.innerHTML = '';

    // Add relative container
    domNode.appendChild(state.container = document.createElement('div'));
    state.container.className = 'scene-container';
    state.container.style.position = 'relative';

    // Add nav info section
    state.container.appendChild(state.navInfo = document.createElement('div'));
    state.navInfo.className = 'scene-nav-info';
    state.navInfo.textContent = {
        orbit: 'Left-click: rotate, Mouse-wheel/middle-click: zoom, Right-click: pan',
        trackball: 'Left-click: rotate, Mouse-wheel/middle-click: zoom, Right-click: pan',
        arcball: 'Left-click: rotate, Mouse-wheel/middle-click: zoom, Right-click: pan',
        fly: 'WASD: move, R|F: up | down, Q|E: roll, up|down: pitch, left|right: yaw'
      }[controlType] || '';
    state.navInfo.style.display = state.showNavInfo ? null : 'none';

    // Setup tooltip
    state.tooltip = new Tooltip(state.container);

    // Capture pointer coords on move or touchstart
    state.pointerPos = new three.Vector2();
    state.pointerPos.x = -2; // Initialize off canvas
    state.pointerPos.y = -2;
    ['pointermove', 'pointerdown'].forEach(evType =>
      state.container.addEventListener(evType, ev => {
        // track click state
        evType === 'pointerdown' && (state.isPointerPressed = true);

        // detect point drag
        !state.isPointerDragging && ev.type === 'pointermove'
          && (ev.pressure > 0 || state.isPointerPressed) // ev.pressure always 0 on Safari, so we used the isPointerPressed tracker
          && (ev.pointerType === 'mouse' || ev.movementX === undefined || [ev.movementX, ev.movementY].some(m => Math.abs(m) > 1)) // relax drag trigger sensitivity on non-mouse (touch/pen) events
          && (state.isPointerDragging = true);

        if (state.enablePointerInteraction) {
          // update the pointer pos
          const offset = getOffset(state.container);
          state.pointerPos.x = ev.pageX - offset.left;
          state.pointerPos.y = ev.pageY - offset.top;
        }

        function getOffset(el) {
          const rect = el.getBoundingClientRect(),
            scrollLeft = window.pageXOffset || document.documentElement.scrollLeft,
            scrollTop = window.pageYOffset || document.documentElement.scrollTop;
          return { top: rect.top + scrollTop, left: rect.left + scrollLeft };
        }
      }, { passive: true })
    );

    // Handle click events on objs
    state.container.addEventListener('pointerup', ev => {
      if (!state.isPointerPressed) return; // don't trigger click events if pointer is not pressed on the canvas

      state.isPointerPressed = false;
      if (state.isPointerDragging) {
        state.isPointerDragging = false;
        if (!state.clickAfterDrag) return; // don't trigger onClick after pointer drag (camera motion via controls)
      }

      requestAnimationFrame(() => { // trigger click events asynchronously, to allow hoverObj to be set (on frame)
        if (state.destroyed) return; // don't fire callbacks after teardown
        if (ev.button === 0) { // left-click
          state.onClick(state.hoverObj || null, ev, state.intersection) // trigger background clicks with null
        }

        if (ev.button === 2 && state.onRightClick) { // right-click
          state.onRightClick(state.hoverObj || null, ev, state.intersection)
        }
      });
    }, { passive: true, capture: true }); // use capture phase to prevent propagation blocking from controls (specifically for fly)

    state.container.addEventListener('contextmenu', ev => {
      if (state.onRightClick) ev.preventDefault(); // prevent default contextmenu behavior and allow pointerup to fire instead
    });

    // Setup renderer, camera and controls
    state.renderer = new (useWebGPU ? WebGPURenderer : three.WebGLRenderer)(Object.assign({ antialias: true, alpha: true }, rendererConfig));
    state.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio)); // clamp device pixel ratio
    state.container.appendChild(state.renderer.domElement);

    // Setup extra renderers
    state.extraRenderers = extraRenderers;
    state.extraRenderers.forEach(r => {
      // overlay them on top of main renderer
      r.domElement.style.position = 'absolute';
      r.domElement.style.top = '0px';
      r.domElement.style.pointerEvents = 'none';
      state.container.appendChild(r.domElement);
    });

    // configure post-processing composer
    state.postProcessingComposer = new ThreeEffectComposer(state.renderer);
    state.postProcessingComposer.addPass(new ThreeRenderPass(state.scene, state.camera)); // render scene as first pass

    // configure controls
    state.controls = new (isClass(controlType) ? controlType : {
      trackball: ThreeTrackballControls,
      arcball: ThreeArcballControls,
      orbit: ThreeOrbitControls,
      fly: ThreeFlyControls
    }[controlType])(state.camera, state.renderer.domElement);

    if (controlType === 'fly') {
      state.controls.movementSpeed = 300;
      state.controls.rollSpeed = Math.PI / 6;
      state.controls.dragToLook = true;
    }

    if (controlType === 'trackball' || controlType === 'arcball' || controlType === 'orbit') {
      state.controls.minDistance = 0.1;
      state.controls.maxDistance = state.skyRadius;
      state.controls.addEventListener('start', () => {
        state.controlsEngaged = true;
      });
      state.controls.addEventListener('change', () => {
        if (state.controlsEngaged) {
          state.controlsDragging = true;
        }
      });
      state.controls.addEventListener('end', () => {
        state.controlsEngaged = false;
        state.controlsDragging = false;
      });

      state.renderer.domElement.style.cursor = null; // remove cursor: auto property on canvas
    }

    [state.renderer, state.postProcessingComposer, ...state.extraRenderers]
      .forEach(r => r.setSize(state.width, state.height));
    state.camera.aspect = state.width/state.height;
    state.camera.updateProjectionMatrix();

    state.camera.position.z = 1000;

    // add sky
    state.scene.add(state.skysphere = new three.Mesh());
    state.skysphere.material = state.bgImageMaterial = new three.MeshBasicMaterial({ side: three.BackSide });
    state.skysphere.visible = false;
    state.loadComplete = state.scene.visible = !waitForLoadComplete;

    window.scene = state.scene;
  },

  update(state, changedProps) {
    if (state.destroyed) return; // no state changes or renders after teardown

    // resize canvas
    if (state.width && state.height && (changedProps.hasOwnProperty('width') || changedProps.hasOwnProperty('height'))) {
      const w = state.width;
      const h = state.height;
      state.container.style.width = `${w}px`;
      state.container.style.height = `${h}px`;
      [state.renderer, state.postProcessingComposer, ...state.extraRenderers]
        .forEach(r => r.setSize(w, h));
      state.camera.aspect = w/h;

      const o = state.viewOffset.slice(0, 2);
      o.some(n => n) && state.camera.setViewOffset(w, h, ...o, w, h);

      state.camera.updateProjectionMatrix();
    }

    if (changedProps.hasOwnProperty('viewOffset')) {
      const w = state.width;
      const h = state.height;
      const o = state.viewOffset.slice(0, 2);
      o.some(n => n)
        ? state.camera.setViewOffset(w, h, ...o, w, h)
        : state.camera.clearViewOffset()
    }

    if (changedProps.hasOwnProperty('skyRadius') && state.skyRadius) {
      state.controls.hasOwnProperty('maxDistance') && changedProps.skyRadius
        && (state.controls.maxDistance = Math.min(state.controls.maxDistance, state.skyRadius));
      state.camera.far = state.skyRadius * 2.5;
      state.camera.updateProjectionMatrix();
      state.skysphere.geometry = new three.SphereGeometry(state.skyRadius);
    }

    if (changedProps.hasOwnProperty('backgroundColor')) {
      let alpha = parseToRgb(state.backgroundColor).alpha;
      if (alpha === undefined) alpha = 1;
      state.renderer.setClearColor(new three.Color(opacify(1, state.backgroundColor)), alpha);
    }

    if (changedProps.hasOwnProperty('backgroundImageUrl')) {
      applyBackgroundImage(state);
    }

    changedProps.hasOwnProperty('showNavInfo') && (state.navInfo.style.display = state.showNavInfo ? null : 'none');

    if (changedProps.hasOwnProperty('lights')) {
      (changedProps.lights || []).forEach(light => state.scene.remove(light)); // Clear the place
      state.lights.forEach(light => state.scene.add(light)); // Add to scene
    }

    if (changedProps.hasOwnProperty('objects')) {
      (changedProps.objects || []).forEach(obj => state.scene.remove(obj)); // Clear the place
      state.objects.forEach(obj => state.scene.add(obj)); // Add to scene
    }
  }
});


function isClass(value) {
  return typeof value === 'function' &&
    Function.prototype.toString.call(value).startsWith('class');
}