# Game Engine Editor - Complete Feature List

## Core Features

### 1. Scene Management
- Create, edit, and manage 3D scenes
- **Undo / Redo** beside Play records up to 20 changes per project, including scenes, objects, web layouts, timelines, visibility and the asset library. Use Ctrl+Z and Ctrl+Shift+Z or Ctrl+Y outside text fields. Consecutive typing in one field is grouped; making a new edit after undo discards the redo branch. Play and selection are not history steps.
- History is stored in `data/history` as per-project JSON, with large data URLs stored once by content hash. It survives refresh and is transferred to a project on its first save. Opening a project restores its saved state and records it in that project's history if different from the latest state. Reset Scene starts a separate draft, so it is not undoable across projects. The 50 MiB API request limit also applies to a single history asset; unreferenced history blobs are not automatically removed. Conflicting writes from another tab stop history recording and display an error; reload before continuing. If history storage fails, saving the project is still possible and reports that history is unavailable.
- Real-time scene preview in viewport
- Automatic scene recovery from IndexedDB and named project save/load through JSONL
- Create, rename, open and delete scenes/pages from **Assets → Scenes / Pages**. Each scene has its own objects and options; the last scene cannot be deleted.
- Web component actions can open another scene/page in Play and in exported projects. Revisiting a scene restarts its initial state; Stop restores the original editing scene and its transforms.
- Scene-agent context labels objects and assets with `gameengine_type` metadata, separate from executable scripts. The agent can propose an `addscenebutton` operation by adding a web button with a valid destination scene ID; review is required before applying it.
- Export built-in objects and attached GLB models, textures, and sounds

### 2. Object Management
- Add primitives: Box, Sphere, Cylinder, Cone, Ground
- Add **3D Text** (Droid Sans extruded geometry) and **SDF Text** (Troika and Noto Sans).
  Text, size and 3D depth are editable. SDF text is limited to Latin-1 and Turkish
  characters; unsupported characters are rejected to prevent online font fallback.
- Add lights: Point Light, Spot Light
- Add cameras for scene composition
- Select a camera under Scene Options → General → Play Camera to use its initial position, rotation, field of view and clipping planes in Play and ZIP exports. Stop restores the editor view; deleting the selected camera returns to the default camera.
- A selected Play Camera can also be animated by the scene timeline. Only timeline position and rotation channels on the selected camera drive the playback view; the older object animation panel still animates the camera object rather than the view.
- Import GLB 3D models with automatic scaling
- Transform objects (position, rotation, scale)
- Scroll to rotate selected objects
- Single-object selection and property editing

### 3. Physics System
- Gravity simulation (-9.8 default)
- Velocity and acceleration tracking
- Collision detection and response
- Kinematic objects (fixed position)
- Dynamic objects with physics
- Ground collision detection
- Customizable physics per object
- Linear damping reduces dynamic-body velocity over time. Zero is the default for existing scenes; kinematic objects are unaffected. It is not a full rigid-body physics solver.
- Enable **Physics** on a mesh or GLB model to use automatic object bounds or a custom box collider with editable local dimensions. Collision detection uses world-axis-aligned bounding boxes, including for rotated boxes; it is not exact oriented-box or mesh collision.
- A physics object can be a **Trigger**. It does not produce physical collision response or collide with the ground. When it overlaps another physics-enabled object, both objects' scripts receive `triggerEnter(other)` and `triggerExit(other)` once per entry/exit. `other` is the other Three.js object. Trigger events and collider sizes are included in ZIP exports.

### 4. Character Controller
- WASD/Arrow key movement
- Space bar jumping
- Ground detection
- Configurable movement speed
- Customizable jump force
- Smooth camera-relative movement
- Select **Existing camera**, **First person (FPS)** or **Third person (RPG)** in Character Controller. The optional FPS/RPG camera follows the player's object; height, mouse sensitivity and third-person distance are editable. Click the viewport to capture the mouse and press Escape to release it. Only one FPS/RPG camera controller can be active per scene, and it requires enabled, non-kinematic physics. Existing scenes retain their original camera behavior.
- The player camera takes priority over timeline camera movement while active. It follows the object but is not a prefab or parent-child attachment, and the third-person camera does not avoid walls.

### 4a. Scene AI algorithms
- **Scene Options → AI Algorithms** edits a scene-specific grid, start/goal, Q-learning settings and regression points. `0` is walkable and `1` is blocked; coordinates are X,Y. Click **Run algorithm** to inspect results and **Save AI settings** to persist them.
- A* and Dijkstra find shortest paths on a uniform-cost, four-direction grid; an unreachable goal returns an empty path and null cost. Q-learning trains on that grid using the configured seed, episode count, learning rate, discount and exploration. Its result includes a greedy path, Q values, successful episodes and whether that path reaches the goal; training is not guaranteed to succeed.
- Linear regression fits `y = slope * x + intercept` and predicts the configured X. Equal X values and malformed inputs are rejected. Grids are limited to 32×32 and Q-learning to 1,000 episodes.
- After saving settings, object scripts can call `state.ai.findPath('astar')`, `state.ai.findPath('dijkstra')`, `state.ai.train()` and `state.ai.regress()`. The same algorithms and settings are embedded in ZIP exports.
- Select a mesh or GLB model and enable **AI Navigation** to follow the saved grid using A*, Dijkstra or a trained Q-learning path. The grid start maps to the object's Play starting position; cells map to X/Z with adjustable size and speed. The object travels back and forth while preserving its height; optional facing assumes +Z is forward. Stop restores the edit pose. An unreachable path or unsuccessful training reports an error in Play and export.
- Enable "Avoid scene colliders and replan" to route around solid physics-enabled objects using their world-space AABB bounds. Moving obstacles are checked while playing; the NPC waits and retries if no safe path exists. Triggers are not obstacles. Previously saved followers retain their original grid-only behavior until this option is enabled.
- For physics interactions enable kinematic physics on the follower. Solid contacts and triggers call `collisionEnter(other)`, `collisionExit(other)`, `triggerEnter(other)` and `triggerExit(other)` on object scripts in Play and exports. Kinematic followers do not respond to gravity or forces. Disable the character controller and conflicting property animations; remove X/Z timeline channels (and Y rotation when facing the path). Scripts can override movement. Navigation uses a bounded 2D grid and AABB approximations, not a full 3D navigation or physics engine.

### 5. Animation System
- **Tween.js** animates one selected object property: position, rotation, scale,
  or material opacity, with duration, easing, repeat and yoyo. Opacity requires
  a mesh or sprite material. Timeline channels take priority over the same property.
- **Float** adds a visual bob and rotation with configurable speed, height and
  rotation. It is inspired by Drei's Float, not the Drei component itself.
  It cannot run on objects with physics, character control or AI navigation enabled;
  conflicting settings are reported. Stop restores the edit state.
- Select an imported GLB animation clip in the model's **GLB Animation Clips** properties. Enable play on start, choose looping, and set playback speed; clips also run in exported games.
- Stopping Play restores the model's pre-play pose. One GLB clip can play per model; the scene timeline can sequence clips without overlap.
- Rotation animations (auto-play)
- Movement animations (path-based)
- Enable **Play on start** on each rotation or movement animation to run it in Play and exports. The settings are stored on the object, not inserted into its JavaScript.
- Rotation also supports the **Scroll / Mouse Wheel** trigger, with direction and X/Y/Z speed controls. Speed is radians per 100 pixels of scrolling; vertical touch swipes are also supported.
- Rotation and movement animations can open a scene when they finish: enable Play on start, disable Loop and select the destination under **When animation finishes**. Scroll-driven animations have no completion event.
- GLB Animation Clips also offer a completion destination for the selected clip. It works for a non-looping clip started automatically or by a web action. Looping clips do not finish.
- Duration is in milliseconds. Non-looping movement holds its end position and non-looping rotation stops after its duration; looping movement repeats from the start.
- Other keyboard, mouse, collision and proximity triggers in this panel are not implemented yet; use web component actions for supported interactions.
- Use Play to preview object animations; Stop restores the original transform.
- The **Timeline** tab beside **In Scene** stores one timeline per scene. The common seconds ruler can be dragged to scrub the preview; the playhead is shown across the channel and segment lanes. Select an object, add a channel, edit keyframe values and drag diamonds to change their time. **Add XYZ** adds all three channels of the chosen 3D position, rotation or scale group. **Capture** records a 3D object's current transform for a keyframe; use the existing transform gizmo or properties to set it.
- 3D objects and cameras support position, rotation (degrees), and scale channels. Web components, including images, support X/Y translation (pixels), rotation (degrees), scale and opacity. Web audio and video support media keyframes (0 pauses, 1 plays). Browser autoplay restrictions still apply.
- For a selected GLB model, choose an embedded clip and **Add GLB clip**. Choose an attached object sound and **Add object sound**. Drag segments along the ruler or edit their start and duration. Segments must fit the timeline; clips on the same model cannot overlap. The clip uses its normal speed: a shorter segment cuts it off and a longer segment holds its last frame. Between clips the previous pose holds; before the first clip the model uses its original pose.
- Object sound segments retain their configured volume and loop settings and remain non-positional, like existing object sounds. During Play, a segment plays within its time interval; keyboard pause pauses it and scroll seeks to the relevant offset. Timeline preview is silent. The browser may block playback until a user gesture. Removing an attached sound asks for confirmation and removes its timeline segments.
- Each keyframe can set the easing toward the next key: constant speed, accelerate, decelerate or smooth start and stop. Existing tracks default to linear interpolation; media changes at its keyframes. The first and last values hold outside their keyframe range. One channel may control each property of an object. The initial keyframe is applied as soon as Play starts; a keyboard-triggered media track stays paused until playback is toggled on.
- **Device values** selects desktop, tablet or mobile keyframe values for 3D and web channels. Tablet and mobile inherit the desktop value until edited; use **Use desktop** to clear an override. Keyframe times and easing remain shared. Runtime selects mobile at up to 767 px, tablet at 768–1024 px and desktop above 1024 px, and responds to resizing. This selection is shared with the web layout and viewport device preview.
- Choose Play on start, a key to toggle playback/pause, or page scroll to drive the timeline. Scroll maps the web layer's scroll position to the full duration and requires content taller than the viewport. The key must be set; repeated keydown events and typing in form fields are ignored.
- Timeline channels apply after scripts, physics, the character controller and existing property animations, so they take priority for the same property. Other properties continue to use those systems. Models with timeline clips and object sounds with timeline segments do not also autoplay through the older controls; web actions targeting them report that the timeline controls them. A web component with a timeline transform or opacity channel has its built-in entrance animation disabled while the timeline is active. Stop restores the edit scene, and deleting an object removes its channels and segments.
- Timeline settings persist per scene and are embedded with the timeline player in each exported scene's generated JavaScript. **Preview** scrubs a temporary copy of the scene, including GLB poses, without changing saved transforms; media is not played in this preview. Switch to Web mode to preview web channels. Clip blending, custom Bezier curves and multiple timelines per scene are not yet available.

### 6. Material Properties
- Color control
- Metalness adjustment
- Roughness control
- Opacity/transparency
- Texture mapping (diffuse, normal, roughness, metalness)
- Real-time material preview

### 7. Lighting
- Scene Options offers locally generated studio, sunset and night environments,
  or an uploaded HDR environment, with an optional background. These procedural
  presets are not Drei's remote preset files. HDR data is saved with the scene.
- Ambient light intensity control
- Directional lighting
- Shadow support (enable/disable)
- FOG effects with density control
- Customizable fog color

### 8. Play Mode
- Sandbox play environment
- Physics simulation in real-time
- Character controller activation
- Animation playback
- Auto-reset on stop
- WASD/arrow movement and Space to jump

### 9. Export System
- Export supported scene objects to a ZIP file
- Choose **HTML** (the original standalone ZIP), **React** (a Vite project), or **WordPress** (an installable plugin). React and WordPress host the same generated player in an iframe rather than converting scene elements into native React components or WordPress blocks. The iframe has its own scrolling and runtime state.
- For React, extract the ZIP, run `npm install` and `npm run dev`, or run `npm run build` for deployment. For WordPress, install and activate the ZIP, then put `[three_scene]` in a page. Upload a replacement plugin to update the scene; this export supports one scene package per installation.
- The exported player includes Three.js and GLTFLoader locally under `vendor`, with their license. It tries public CDNs only if local loading fails; fallback requires internet access and an appropriate hosting policy. Only install or publish scene scripts and assets you trust.
- Includes HTML player (index.html)
- Includes complete scene.json with all data
- Auto-generated Three.js code
- Responsive player layout (keyboard controls)
- Physics and animations in exported game
- FPS counter and controls display
- Object scripts can define `start`, `update(delta)`, `click`, `triggerEnter(other)`, `triggerExit(other)` and `stop` handlers
- Multi-scene ZIPs contain one HTML/JavaScript pair per scene; upload all files together. The active scene is `index.html`. Each navigation reloads the destination page and its runtime state.
- Imported library assets and embedded scene models, textures, sounds, images and videos are files under `web3dassets` beside the scene player (inside `public/scene` for React and the plugin's `scene` folder for WordPress). The player and `scene.json` reference those files; identical embedded data is stored once. External URLs and embedded Lottie JSON are not downloaded or rewritten. Serve the HTML export over HTTP rather than opening it as a local file, so browser restrictions do not block model loading.
- Uploaded HDR environments are also packaged in `web3dassets`. When used, Tween.js,
  SDF dependencies, fonts and their third-party license notices are included locally
  under `vendor`. GSAP is not included. Desktop notices are in `resources/third-party`.
- Web styling is generated at runtime from exported scene data; a separate CSS file is not generated.
- The 3D viewport pauses while the ZIP is being prepared and resumes when export finishes or fails
- Export packaging code loads on demand instead of during editor startup.

### 10. Responsive UI/UX
- **Desktop**: Full-featured editor with all panels visible
- **Tablet**: Collapsible sidebar and properties panel
- **Mobile**: Touch-optimized interface with menu toggles
- Header collapse and adaptive button sizing
- Smooth panel transitions and overlays
- Touchscreen-friendly buttons and controls

### Web layer
- Add sections, columns, containers, cards, sliders, slides, headings, text, buttons, menus, images, video, audio, and Lottie animations from **Web Components**
- Adding a slider creates its first slide. Select a slider or a slide and add another slide; select a slide to add sections, columns, containers, cards and media within it. All slides are visible while editing; Play and ZIP show one at a time with previous/next buttons, keyboard arrows and touch swipes on slider content.
- A slider's full viewport height, padding, margins and border radius are editable. Its width follows its parent, so place it at the page root for full-width output. Slides can have an image and a muted looping background video; the video overlays the image. Web audio components support playback controls, looping and optional autoplay. Hidden-slide video and audio pause; autoplay may be blocked by browser policy.
- A slider accepts only slide children. Deleting a slider turns its slides into sections to preserve their content; deleting a slide moves its direct children outside the slider.
- New sections and menus start transparent. **Background mode** explicitly selects transparent, solid or gradient styling; explicit modes override stylesheet background declarations, including `!important`. **3D interaction** can pass pointer events through a component while keeping its child controls interactive. Existing scenes retain their saved styling unless these controls are changed; scripts that subsequently set inline styles can still override it.
- Font family, weight, line height, letter spacing, text alignment, maximum width, minimum viewport height, gap, flex direction and alignment are editable per device and work in exports. Existing custom scripts remain in place and may style other properties.
- Image planes preserve PNG alpha transparency, including after reload and export; they do not write to the depth buffer.
- A container lays out its direct children as equal-width cells: select 1, 1/2, 1/3, 1/4 or 1/6. Without an explicit device override, at widths up to 1024px the column count is halved and rounded down; portrait phones and widths up to 480px use one column. Select a card to add multiple items inside one cell.
- Set top, right, bottom and left margin in pixels per component. Images accept GIF and SVG; videos accept MP4 and WebM, with autoplay, mute, loop and controls options. Browser codec and autoplay policies apply.
- Lottie accepts JSON with embedded assets, not external image files. Its player is included locally in ZIP exports. Imported media increases project and export size.
- Select components on the web canvas; drag a component onto a container to reparent it, or onto another component to place it after that component. The Parent field can also move an item to the page root
- Edit text, colors, spacing, CSS class, tags, and column count. Deleting a container moves its direct children to its parent
- Web components also accept custom CSS declarations, applied only to that element; selectors, keyframes and media queries are not supported. Explicit visual controls take priority over conflicting CSS declarations; unchanged legacy fields retain the previous CSS precedence.
- In Web component properties, **Layout device** edits static color, background, font size, padding, margin, dimensions, radius, columns, and slider height separately for desktop, tablet and mobile. Unchanged tablet/mobile fields inherit desktop; **Reset device layout to desktop** clears that device's overrides. Custom CSS still has priority. The same 767/1024 px breakpoints apply in Play and exports, including after a resize.
- Switch between **3D** and **Web** editing and preview desktop, tablet, and mobile widths. The shared device selector also resizes the 3D canvas and camera aspect. Tablet uses 768px and mobile 375px when space permits; narrower editor areas constrain the preview. Play uses the full available area and the actual window width. Columns stack below 700px unless overridden.
- Click, keyboard, and scroll events can scroll to or toggle another web component, or rotate a selected 3D object. Fade and slide entrance animations support start or scroll-into-view triggers
- A web component can run an action, including **Open scene / page**, when its own Fade or Slide up entrance animation finishes. Under reduced-motion settings the action runs when the component would begin animating. This does not trigger on Lottie, video or audio completion.
- Web actions can play a selected GLB clip once or play an attached object sound. Select the target and clip or sound in the web component's properties; the same actions work in Play and ZIP exports. A new clip replaces the currently playing clip on that model.
- In Play, non-interactive section, column, and menu backgrounds let pointer events reach the 3D canvas; use a transparent background to keep the scene visible. Mouse wheel and single-finger swipes on the canvas scroll overflowing web content
- Optional web scripts return `{ start(), click(event), keydown(event), scroll(event), stop() }`. They receive `element`, `scene`, `camera`, `THREE`, `state`, `openScene(id)`, and `scenes` (an array of `{id, name}`). Object scripts also receive `openScene` and `scenes`. For example, `openScene(scenes.find(s => s.name === 'Scene 2 / Page 2').id)`. Use unique names when looking up by name. Scripts run only in Play and the exported player after the existing trust confirmation; a callback from a stopped scene cannot navigate.
- Enable jQuery in Scene Options → General only when needed. It is available to 3D and web scripts in Play; exported ZIPs include a local `jquery.min.js` when enabled.
- Web components are stored with scene objects and work in Play and ZIP exports. Existing scenes without web components are unchanged
- This is a foundational layout/event editor, not a full CSS animation-curve editor, multi-page CMS, or complete game framework

### 11. Local JSONL Project Storage
- Save, open, and delete named projects using the local Node.js API
- Project snapshots and deletion records are appended to `data/projects.jsonl`
- The database is local and has no authentication or multi-user access controls
- Project snapshots include imported GLB models, applied textures, and attached sounds
- Uploaded GLB, images, audio and MP4/WebM files appear in Assets and can be added to scenes or the web layer. Images can also be added as 3D planes. Assets are stored in IndexedDB and in new named JSONL snapshots; opening such a snapshot replaces the local library. Older snapshots without a library leave it unchanged.
- Media used both by objects and by the asset library can be duplicated in project snapshots, increasing their size and reaching the 50 MiB API limit sooner.

## UI Components

### Sidebar
- Component browser (primitives, lights, camera)
- GLB model loader with file browser
- Quick add buttons
- Hover effects and previews

### Viewport
- Real-time Three.js rendering
- Grid ground reference in edit mode; hidden in play mode and exports
- Object selection with click
- Transform controls (gizmo)
- Smooth orbit camera
- Right-click context menu

### Properties Panel
- Object properties editor
- Transform controls (position, rotation, scale)
- Material properties
- Physics properties
- Character controller settings
- Animation editor
- Sound/audio management
- Object names, class and tags, and per-object JavaScript

### Scene Options
- Scene naming
- Background color picker
- Lighting controls
- Fog configuration
- Shadows toggle
- Physics gravity setting

## Advanced Features

### Model Import
- GLB file format support
- Automatic bounding box calculation
- Model centering and scaling
- Proper shadow setup
- Material preservation

### Scene Export
- Complete project packaging
- Standalone playable game
- Responsive HTML player layout (keyboard controls)
- Self-contained scene data
- Three.js and GLTFLoader are included locally, with CDN fallback
- GLB, applied texture maps, and attached sounds are included as files under `web3dassets`
- Sounds marked **Play automatically** play in play mode and the exported game; browser restrictions may require clicking **Enable sound**
- GLB files must contain their resources; compressed formats requiring external decoders (such as Draco) are not supported

### State Management
- Zustand for state persistence
- Auto-save scene and asset library to IndexedDB
- Project state recovery
- Play mode state restoration
- Project-scoped undo and redo (Reset Scene starts a separate draft)

### Animation System
- Multiple animation types supported
- Trigger-based execution
- Parameter customization
- Real-time preview
- Loop and duration control

## Performance Features
- Optimized rendering pipeline
- Shadow map support
- Material caching
- Efficient collision detection
- FPS monitoring in exported game

## Keyboard Shortcuts
- **WASD** - Movement in play mode
- **Arrow Keys** - Movement in play mode
- **Space** - Jump in play mode
- **Mouse Scroll** - Rotate selected object in edit mode
- **Left Click** - Select object
- **Right Click** - Context menu

## File Structure
```
src/
├── components/          # React components
│   ├── Viewport.tsx     # 3D viewport and canvas
│   ├── Sidebar.tsx      # Component browser
│   ├── Properties.tsx   # Object properties editor
│   ├── SceneOptions.tsx # Scene settings
│   └── ...
├── services/            # Utility services
│   ├── modelLoader.ts   # GLB import
│   ├── sceneExporter.ts # Scene export
│   ├── database.ts      # Local project API client
│   └── ...
├── systems/             # Game systems
│   ├── PhysicsEngine.ts # Physics simulation
│   ├── InputManager.ts  # Input handling
│   ├── CharacterControllerSystem.ts
│   └── ...
├── store/              # State management
│   └── editorStore.ts   # Zustand store
└── App.tsx             # Main app component
```

## Technology Stack
- **React 18** - UI framework
- **Three.js** - 3D graphics
- **React Three Fiber** - React renderer for Three.js
- **Zustand** - State management
- **Tailwind CSS** - Styling
- **Node.js and JSONL** - Local project storage
- **TypeScript** - Type safety
- **Vite** - Build tool

## Browser Support
- Chrome/Edge (latest)
- Firefox (latest)
- Safari (latest)
- Mobile browsers (iOS Safari, Chrome Mobile)

## Running locally

Install dependencies with `npm ci`, then run `npm run dev`. The command starts Vite
and a local project API on `127.0.0.1:4318`. `npm run build` followed by
`npm run preview` starts the production preview with the same API. The API has
no authentication and is intended only for local use; do not expose it or the
Vite server to untrusted networks.

Use **Save** to write the current scene to JSONL and **Projects** to create, open or
delete saved projects. Creating a project starts with an empty scene and asset library
after confirmation; save any current work first. **Reset Scene** clears the active scene and detaches the
current project ID; other scenes remain in the editor. Scene edits and the
asset library are also stored in browser IndexedDB. The JSONL file is append-only:
old snapshots and deleted project contents remain in the file. Back it up if
needed. Each JSONL project request is limited to 50 MiB, including JSON and
base64-encoded media; base64 increases file size by roughly one third. IndexedDB
is subject to browser storage quotas. Errors are displayed when a save fails.
Add a GLB to the scene and attach textures and sounds through the selected
object's Properties panel to include them in a project or export.

The Components panel also imports image planes, camera-facing sprites, and audio
sources. Object scripts return an object with optional `start()`, `update(delta)`,
`click()` and `stop()` methods; `object`, `scene`, `camera`, `THREE`, and a
per-object `state` are available. These scripts execute with full browser access,
not in a sandbox. Only run and export projects you trust; a confirmation appears
before execution. Generated code must be reviewed before it is applied or run.

**Options** contains a code assistant for Ollama, OpenAI, Gemini, Claude, OpenRouter, LM Studio and AnythingLLM.
Start Ollama locally at `127.0.0.1:11434`, or set `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, or `ANYTHINGLLM_API_KEY` in the local server's environment before
starting it. `OLLAMA_BASE_URL` can select another loopback HTTP address. Provider
requests send the prompt to the selected service after confirmation; keys are
not stored in project files. Model availability depends on the configured provider.
LM Studio defaults to `http://127.0.0.1:1234`; optionally set `LM_STUDIO_BASE_URL`
and `LM_STUDIO_API_KEY`. AnythingLLM defaults to `http://127.0.0.1:3001`; optionally
set `ANYTHINGLLM_BASE_URL` and enter the workspace slug instead of a model in Options.
The workspace chooses its own model. Both base URLs must be local HTTP addresses.
Options loads available models (or AnythingLLM workspace slugs) from the selected
provider automatically and permits manual entry and refresh if discovery fails.
Selecting a cloud provider sends a model-list request to that provider.
Prompts accept up to 100,000 characters, subject to the selected model's context limit.
The default assistant generates a script for the selected 3D object or web
component, sending the target type along with the prompt. With no selection it
generates 3D object code. Applying replaces the existing script; the current
script can be reviewed in Options. If the selected target changes, generate
again before applying. Stop Play before generating or applying code.
**Scene agent
(review changes)** instead sends scene object properties and existing scripts,
timeline settings, active GLB clip metadata and asset metadata to the selected provider.
It proposes replacement JavaScript, web CSS and selected visual settings for
existing objects, plus new keyframe tracks on existing active-scene objects. Review each proposal,
including the current code, before applying it. It can propose creating built-in
3D objects and web components, adding existing GLB/image/audio/video assets to
the active scene, and deleting scene objects. It never deletes library assets or
edits other scenes. It cannot change existing timeline tracks, add GLB clip or
audio segments, or create scenes. A newly created slider includes its first slide; new web
components can be nested in existing compatible containers. It cannot reference
a newly created object as the parent of another proposed addition in the same
request. Asset loading finishes before any proposed changes are applied; a
failed load leaves the scene unchanged. A change to the scene or
asset library after generation requires a new proposal. Scene context is limited
to 250 KB; embedded media fields are omitted, but scripts and text may still
contain sensitive data. Do not send information you do not want the provider to
receive.

The optional **Capture screen** button uses the browser's screen-sharing
permission and displays a preview before generation; the selected tab or screen
may include sensitive information. The image is resized to at most 1280 pixels
and sent as JPEG only when generating a scene-agent proposal. A vision-capable
model and provider are required; a text-only model may reject the image. Cloud
providers receive the complete disclosed context and screenshot after the
confirmation. Ollama, LM Studio and AnythingLLM run locally, but their configured
models or providers may forward requests remotely; AnythingLLM can retain chats in its workspace.
OpenRouter is remote. The assistant does not execute proposed scripts until Play or
export, and generated code must be reviewed.
For Ollama models supporting reasoning, **Enable model reasoning** controls the
thinking mode. Ollama temperature is optional; leave it blank for the model default.
Local requests time out after three minutes.

## Testing

Run `npx playwright install chromium` once, then `npm test` to run the JSONL
integration tests and browser end-to-end tests. Run `npm run test:integration`
or `npm run test:e2e` to run either suite separately. Browser tests use an
isolated temporary project file and do not modify your saved projects.

The exported game uses the same basic physics and character movement as play
mode. Physics uses simple bounding boxes and an infinite ground plane; it is
not a full platform-game physics engine.

## Next Steps / Future Enhancements
- Advanced physics with constraints
- Particle systems
- Post-processing effects (bloom, DOF, etc.)
- Custom timeline Bezier curves, clip blending and multiple timelines per scene
- Collaborative editing
- Version history
- Shader editor
- C# scripting support
