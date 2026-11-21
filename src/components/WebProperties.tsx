import { useEditorStore } from '../store/editorStore';
import type { SceneObject } from '../types/editor';
import { isWebContainer, isValidWebParent, type WebElement, type WebResponsiveStyle, type WebStyleOverride } from '../types/web';
import { readFileDataUrl } from '../services/media';
import { toast } from 'react-hot-toast';
import { registerAsset } from '../services/assetLibrary';

export function WebProperties({ item }: { item: SceneObject }) {
  const { sceneObjects, scenes, activeSceneId, sceneOptions, updateObject, updateObjectProperties, removeObject,
    timelinePreviewDevice, setTimelinePreviewDevice } = useEditorStore();
  const web = item.properties.web!;
  const layout = { ...web, ...(timelinePreviewDevice === 'desktop' ? undefined : web.responsiveStyles?.[timelinePreviewDevice]) };
  const update = (patch: Partial<WebElement>) => {
    const current = useEditorStore.getState().sceneObjects.find(object => object.id === item.id)?.properties.web;
    if (!current) {
      toast.error('The web component no longer exists.');
      return;
    }
    updateObjectProperties(item.id, { web: { ...current, ...patch } });
  };
  const updateLayout = (patch: WebResponsiveStyle) => {
    if (patch.background !== undefined) {
      patch = { ...patch, backgroundMode: patch.background.trim().toLowerCase() === 'transparent' ? 'transparent' : 'solid' };
    }
    const editableStyles: WebStyleOverride[] = ['color', 'fontSize', 'padding', 'width', 'height', 'borderRadius', 'margin'];
    const changed = editableStyles.filter(key => key in patch);
    if (changed.length) patch = { ...patch, styleOverrides: [...new Set([...(layout.styleOverrides ?? []), ...changed])] };
    if (timelinePreviewDevice === 'desktop') {
      const { width, height, ...rest } = patch;
      update({ ...rest, ...('width' in patch ? { width: width ?? undefined } : {}),
        ...('height' in patch ? { height: height ?? undefined } : {}) });
      return;
    }
    const current = useEditorStore.getState().sceneObjects.find(object => object.id === item.id)?.properties.web;
    if (!current) {
      toast.error('The web component no longer exists.');
      return;
    }
    const responsiveStyles = current.responsiveStyles ?? {};
    const variant = { ...responsiveStyles[timelinePreviewDevice], ...patch };
    for (const key of Object.keys(variant) as (keyof WebResponsiveStyle)[]) {
      if (variant[key] === undefined) delete variant[key];
    }
    update({ responsiveStyles: { ...responsiveStyles,
      [timelinePreviewDevice]: variant } });
  };
  const containers = sceneObjects.filter(candidate => {
    if (!candidate.properties.web || !isWebContainer(candidate.properties.web.kind)) return false;
    if (!isValidWebParent(web.kind, candidate.properties.web.kind)) return false;
    let parent: SceneObject | undefined = candidate;
    const seen = new Set<string>();
    while (parent) {
      if (parent.id === item.id || seen.has(parent.id)) return false;
      seen.add(parent.id);
      parent = sceneObjects.find(value => value.id === parent?.properties.web?.parentId);
    }
    return true;
  });
  const field = 'w-full rounded border border-gray-600 bg-gray-700 p-2 text-sm text-white';
  const actionTarget = sceneObjects.find(candidate => candidate.id === web.targetId);
  return <section className="space-y-3 bg-gray-800 p-4 text-white">
    <h2 className="font-semibold">Web component</h2>
    <label className="block text-xs">Layout device
      <select aria-label="Web layout device" className={field} value={timelinePreviewDevice}
        onChange={event => setTimelinePreviewDevice(event.target.value as 'desktop' | 'tablet' | 'mobile')}>
        <option value="desktop">Desktop</option><option value="tablet">Tablet</option><option value="mobile">Mobile</option>
      </select>
    </label>
    {timelinePreviewDevice !== 'desktop' && <button type="button" className="text-xs text-sky-300"
      onClick={() => {
        const responsiveStyles = { ...web.responsiveStyles };
        delete responsiveStyles[timelinePreviewDevice];
        update({ responsiveStyles });
      }}>Reset device layout to desktop</button>}
    <label className="block text-xs">Name
      <input aria-label="Web component name" className={field} value={item.name} onChange={event => updateObject(item.id, { name: event.target.value })} />
    </label>
    <label className="block text-xs">CSS class
      <input aria-label="Web CSS class" className={field} value={item.properties.className ?? ''} onChange={event => updateObjectProperties(item.id, { className: event.target.value })} />
    </label>
    <label className="block text-xs">Tags (comma separated)
      <input aria-label="Web tags" className={field} defaultValue={(item.properties.tags ?? []).join(', ')} key={item.id}
        onBlur={event => updateObjectProperties(item.id, { tags: event.target.value.split(',').map(value => value.trim()).filter(Boolean) })} />
    </label>
    <label className="block text-xs">Text / accessible label
      <textarea aria-label="Web text" className={field} value={web.text} onChange={event => update({ text: event.target.value })} />
    </label>
    <label className="block text-xs">Parent
      <select aria-label="Web parent" className={field} value={web.parentId ?? ''} onChange={event => update({ parentId: event.target.value || null })}>
        {web.kind !== 'slide' && <option value="">Page root</option>}
        {containers.map(candidate => <option value={candidate.id} key={candidate.id}>{candidate.name}</option>)}
      </select>
    </label>
    {web.kind === 'slider' && <label className="flex items-center gap-2 text-xs">
      <input aria-label="Slider full screen" type="checkbox" checked={layout.fullScreen ?? false}
        onChange={event => updateLayout({ fullScreen: event.target.checked })} />Full viewport height
      <span className="text-gray-400">(width follows its parent)</span>
    </label>}
    {web.kind === 'slide' && <>
      <label className="block text-xs">Slide background image
        <input aria-label="Slide background image" type="file" accept="image/*,.svg,.gif" className={field} onChange={event => {
          const input = event.target;
          const file = input.files?.[0];
          if (!file) return;
          void readFileDataUrl(file).then(backgroundImage => { registerAsset(file, backgroundImage); update({ backgroundImage }); }).catch(error => {
            console.error('Slide background image import failed:', error);
            toast.error('Could not import slide background image');
          }).finally(() => { input.value = ''; });
        }} />
      </label>
      {web.backgroundImage && <button type="button" className="text-xs text-sky-300" onClick={() => update({ backgroundImage: '' })}>Remove background image</button>}
      <label className="block text-xs">Slide background video (MP4 / WebM, muted and looping)
        <input aria-label="Slide background video" type="file" accept="video/mp4,video/webm,.mp4,.webm" className={field} onChange={event => {
          const input = event.target;
          const file = input.files?.[0];
          if (!file) return;
          void readFileDataUrl(file).then(async backgroundVideo => {
            await validateMedia('video', backgroundVideo);
            registerAsset(file, backgroundVideo);
            update({ backgroundVideo });
          }).catch(error => {
            console.error('Slide background video import failed:', error);
            toast.error('Could not import slide background video');
          }).finally(() => { input.value = ''; });
        }} />
      </label>
      {web.backgroundVideo && <button type="button" className="text-xs text-sky-300" onClick={() => update({ backgroundVideo: '' })}>Remove background video</button>}
      <p className="text-xs text-gray-400">Video appears over the background image when both are set.</p>
    </>}
    {web.kind === 'image' && <label className="block text-xs">Image file
      <input aria-label="Web image" type="file" accept="image/*,.svg,.gif" className={field} onChange={event => {
        const file = event.target.files?.[0];
        if (!file) return;
        void readFileDataUrl(file).then(image => { registerAsset(file, image); update({ image }); }).catch(error => {
          console.error('Web image import failed:', error);
          toast.error('Could not import image');
        });
      }} />
    </label>}
    {web.kind === 'video' && <>
      <label className="block text-xs">MP4 / WebM file
        <input aria-label="Web video" type="file" accept="video/mp4,video/webm,.mp4,.webm" className={field} onChange={event => {
          const input = event.target;
          const file = input.files?.[0];
          if (!file) return;
          void readFileDataUrl(file).then(async video => {
            await validateMedia('video', video);
            registerAsset(file, video);
            update({ video });
          }).catch(error => {
            console.error('Video import failed:', error);
            toast.error('Could not import video');
          }).finally(() => { input.value = ''; });
        }} />
      </label>
      {([
        ['videoAutoPlay', 'Autoplay', true], ['videoMuted', 'Muted', true],
        ['videoLoop', 'Loop', true], ['videoControls', 'Show controls', true]
      ] as const).map(([key, label, defaultValue]) => <label key={key} className="flex items-center gap-2 text-xs">
        <input aria-label={`Web video ${label.toLowerCase()}`} type="checkbox" checked={web[key] ?? defaultValue}
          onChange={event => update({ [key]: event.target.checked })} />{label}
      </label>)}
      <p className="text-xs text-gray-400">Browsers may block autoplay when sound is enabled.</p>
    </>}
    {web.kind === 'audio' && <>
      <label className="block text-xs">Audio file
        <input aria-label="Web audio" type="file" accept="audio/*" className={field} onChange={event => {
          const input = event.target;
          const file = input.files?.[0];
          if (!file) return;
          void readFileDataUrl(file).then(async audio => {
            await validateMedia('audio', audio);
            registerAsset(file, audio);
            update({ audio });
          }).catch(error => {
            console.error('Web audio import failed:', error);
            toast.error('Could not import audio');
          }).finally(() => { input.value = ''; });
        }} />
      </label>
      {web.audio && <button type="button" className="text-xs text-sky-300" onClick={() => update({ audio: '' })}>Remove audio</button>}
      {([
        ['audioAutoPlay', 'Autoplay', false], ['audioLoop', 'Loop', false], ['audioControls', 'Show controls', true]
      ] as const).map(([key, label, defaultValue]) => <label key={key} className="flex items-center gap-2 text-xs">
        <input aria-label={`Web audio ${label.toLowerCase()}`} type="checkbox" checked={web[key] ?? defaultValue}
          onChange={event => update({ [key]: event.target.checked })} />{label}
      </label>)}
      <p className="text-xs text-gray-400">Browsers may block autoplay until the visitor interacts with the page.</p>
    </>}
    {web.kind === 'lottie' && <label className="block text-xs">Lottie JSON (embedded assets only)
      <input aria-label="Web Lottie JSON" type="file" accept=".json,application/json" className={field} onChange={event => {
        const input = event.target;
        const file = input.files?.[0];
        if (!file) return;
        void file.text().then(text => {
          const data: unknown = JSON.parse(text);
          if (!data || typeof data !== 'object' || !('layers' in data) || !Array.isArray(data.layers) ||
              !('fr' in data) || typeof data.fr !== 'number' || !Number.isFinite(data.fr) || data.fr <= 0 ||
              !('ip' in data) || typeof data.ip !== 'number' || !Number.isFinite(data.ip) ||
              !('op' in data) || typeof data.op !== 'number' || !Number.isFinite(data.op) || data.op <= data.ip ||
              !('w' in data) || typeof data.w !== 'number' || !Number.isFinite(data.w) || data.w <= 0 ||
              !('h' in data) || typeof data.h !== 'number' || !Number.isFinite(data.h) || data.h <= 0) {
            throw new Error('Invalid Lottie animation');
          }
          if ('assets' in data && Array.isArray(data.assets) && data.assets.some((asset: unknown) =>
            asset && typeof asset === 'object' && 'p' in asset && typeof asset.p === 'string' &&
            (!asset.p.startsWith('data:') || ('u' in asset && typeof asset.u === 'string' && asset.u !== '')))) {
            throw new Error('Lottie external assets must be embedded');
          }
          update({ lottieData: text });
        }).catch(error => {
          console.error('Lottie import failed:', error);
          toast.error(error instanceof Error ? error.message : 'Could not import Lottie JSON');
        }).finally(() => { input.value = ''; });
      }} />
    </label>}
    <label className="block text-xs">Text color
      <input aria-label="Web text color" type="color" className={field} value={layout.color} onChange={event => updateLayout({ color: event.target.value })} />
    </label>
    <label className="block text-xs">Background color or transparent
      <input aria-label="Web background" className={field} value={layout.background} onChange={event => updateLayout({ background: event.target.value })} />
    </label>
    <label className="block text-xs">Background mode
      <select aria-label="Web background mode" className={field} value={layout.backgroundMode ?? 'legacy'}
        onChange={event => updateLayout({ backgroundMode: event.target.value as WebElement['backgroundMode'] })}>
        <option value="legacy">Existing styling</option><option value="transparent">Transparent</option>
        <option value="solid">Background value</option><option value="gradient">Gradient</option>
      </select>
      <span className="text-gray-400">Explicit modes override stylesheet backgrounds, including !important rules.</span>
    </label>
    {layout.backgroundMode === 'gradient' && <>
      {(['gradientFrom', 'gradientTo'] as const).map((key, index) => <label key={key} className="block text-xs">
        Gradient {index ? 'end' : 'start'}
        <input aria-label={`Web gradient ${index ? 'end' : 'start'}`} type="color" className={field}
          value={layout[key] ?? (index ? '#64748b' : '#0b1220')} onChange={event => updateLayout({ [key]: event.target.value })} />
      </label>)}
      <label className="block text-xs">Gradient angle
        <input aria-label="Web gradient angle" type="number" min="0" max="360" className={field} value={layout.gradientAngle ?? 90}
          onChange={event => updateLayout({ gradientAngle: Math.max(0, Math.min(360, Number(event.target.value))) })} />
      </label>
    </>}
    <label className="block text-xs">3D interaction
      <select aria-label="Web pointer mode" className={field} value={layout.pointerMode ?? ''}
        onChange={event => updateLayout({ pointerMode: event.target.value ? event.target.value as WebElement['pointerMode'] : undefined })}>
        <option value="">Automatic</option><option value="pass-through">Pass through this component</option><option value="auto">Receive pointer events</option>
      </select>
      <span className="text-gray-400">Pass-through keeps child buttons and media interactive.</span>
    </label>
    <label className="block text-xs">Font family
      <select aria-label="Web font family" className={field} value={layout.fontFamily ?? ''}
        onChange={event => updateLayout({ fontFamily: event.target.value ? event.target.value as WebElement['fontFamily'] : undefined })}>
        <option value="">Default</option><option value="system-ui">Sans-serif</option><option value="serif">Serif</option><option value="monospace">Monospace</option>
      </select>
    </label>
    <label className="block text-xs">Text alignment
      <select aria-label="Web text alignment" className={field} value={layout.textAlign ?? ''}
        onChange={event => updateLayout({ textAlign: event.target.value ? event.target.value as WebElement['textAlign'] : undefined })}>
        <option value="">Default</option><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
      </select>
    </label>
    {([
      ['fontWeight', 'Font weight', 100, 900, 100],
      ['lineHeight', 'Line height', 0.5, 4, 0.1],
      ['letterSpacing', 'Letter spacing (px)', -20, 50, 0.1],
      ['maxWidth', 'Maximum width (px)', 1, 10000, 1],
      ['minHeightVh', 'Minimum height (vh)', 0, 300, 1],
      ['gap', 'Layout gap (px)', 0, 500, 1]
    ] as const).map(([key, label, min, max, step]) => <label key={key} className="block text-xs">{label}
      <input aria-label={`Web ${label.toLowerCase()}`} type="number" min={min} max={max} step={step} className={field}
        value={layout[key] ?? ''} onChange={event => {
          if (!event.target.value) { updateLayout({ [key]: undefined }); return; }
          const value = event.target.valueAsNumber;
          if (Number.isFinite(value) && value >= min && value <= max) updateLayout({ [key]: value });
        }} />
    </label>)}
    {isWebContainer(web.kind) && <>
      <label className="block text-xs">Content layout
        <select aria-label="Web content layout" className={field} value={layout.layoutDirection ?? 'default'}
          onChange={event => updateLayout({ layoutDirection: event.target.value as WebElement['layoutDirection'] })}>
          <option value="default">Default</option><option value="column">Vertical</option><option value="row">Horizontal</option>
        </select>
      </label>
      <label className="block text-xs">Align items
        <select aria-label="Web align items" className={field} value={layout.alignItems ?? ''}
          onChange={event => updateLayout({ alignItems: event.target.value ? event.target.value as WebElement['alignItems'] : undefined })}>
          <option value="">Default</option><option value="start">Start</option><option value="center">Center</option><option value="end">End</option><option value="stretch">Stretch</option>
        </select>
      </label>
      <label className="block text-xs">Justify content
        <select aria-label="Web justify content" className={field} value={layout.justifyContent ?? ''}
          onChange={event => updateLayout({ justifyContent: event.target.value ? event.target.value as WebElement['justifyContent'] : undefined })}>
          <option value="">Default</option><option value="start">Start</option><option value="center">Center</option><option value="end">End</option><option value="space-between">Space between</option>
        </select>
      </label>
    </>}
    <label className="block text-xs">Font size
      <input aria-label="Web font size" type="number" min="8" max="200" className={field} value={layout.fontSize} onChange={event => updateLayout({ fontSize: Math.max(8, Math.min(200, Number(event.target.value))) })} />
    </label>
    <label className="block text-xs">Padding
      <input aria-label="Web padding" type="number" min="0" max="200" className={field} value={layout.padding} onChange={event => updateLayout({ padding: Math.max(0, Math.min(200, Number(event.target.value))) })} />
    </label>
    <label className="block text-xs">Border radius (px)
      <input aria-label="Web border radius" type="number" min="0" max="500" className={field} value={layout.borderRadius ?? 0}
        onChange={event => {
          const value = event.target.valueAsNumber;
          if (Number.isFinite(value) && value >= 0 && value <= 500) updateLayout({ borderRadius: value });
        }} />
    </label>
    {(['width', 'height'] as const).map(dimension => <label key={dimension} className="block text-xs">
      {dimension === 'width' ? 'Width' : 'Height'} (px; empty = automatic)
      <input aria-label={`Web ${dimension}`} type="number" min="1" max="10000" className={field} value={layout[dimension] ?? ''}
        onChange={event => {
          if (!event.target.value) { updateLayout({ [dimension]: null }); return; }
          const value = event.target.valueAsNumber;
          if (Number.isFinite(value) && value >= 1 && value <= 10000) updateLayout({ [dimension]: value });
        }} />
    </label>)}
    <fieldset className="block text-xs">
      <legend>Margin (px)</legend>
      <div className="grid grid-cols-4 gap-1">
        {(['Top', 'Right', 'Bottom', 'Left'] as const).map((side, index) => <label key={side}>{side}
          <input aria-label={`Web margin ${side.toLowerCase()}`} type="number" min="0" max="500" className={field}
            value={(layout.margin ?? [0, 0, 0, 0])[index]} onChange={event => {
              const value = event.target.valueAsNumber;
              if (!Number.isFinite(value) || value < 0 || value > 500) return;
              const margin: [number, number, number, number] = [...(layout.margin ?? [0, 0, 0, 0])];
              margin[index] = value;
              updateLayout({ margin });
            }} />
        </label>)}
      </div>
    </fieldset>
    {web.kind === 'container' && <label className="block text-xs">Item width
      <select aria-label="Container item width" className={field} value={layout.columns} onChange={event => updateLayout({ columns: Number(event.target.value) })}>
        {[1, 2, 3, 4, 6].map(value => <option key={value} value={value}>1/{value}</option>)}
      </select>
      <span className="text-gray-400">Tablet / landscape: half the columns (rounded down). Portrait phone: one column.</span>
    </label>}
    {web.kind === 'columns' && <label className="block text-xs">Columns
      <input aria-label="Web columns" type="number" min="1" max="4" className={field} value={layout.columns} onChange={event => updateLayout({ columns: Math.max(1, Math.min(4, Number(event.target.value))) })} />
    </label>}
    <label className="block text-xs">Entrance animation
      <select aria-label="Web animation" className={field} value={web.animation} onChange={event => update({ animation: event.target.value as WebElement['animation'] })}>
        <option value="none">None</option><option value="fade">Fade</option><option value="slide">Slide up</option>
      </select>
    </label>
    {web.animation !== 'none' && <label className="block text-xs">Animation trigger
      <select aria-label="Web animation trigger" className={field} value={web.animationTrigger ?? 'load'} onChange={event => update({ animationTrigger: event.target.value as WebElement['animationTrigger'] })}>
        <option value="load">On start</option><option value="scroll">When scrolled into view</option>
      </select>
    </label>}
    <label className="block text-xs">Event
      <select aria-label="Web event" className={field} value={web.trigger} onChange={event => update({ trigger: event.target.value as WebElement['trigger'] })}>
        <option value="click">Click</option><option value="key">Keyboard</option><option value="scroll">Scroll</option><option value="animationEnd">Entrance animation ends</option>
      </select>
    </label>
    {web.trigger === 'key' && <label className="block text-xs">Key
      <input aria-label="Web event key" className={field} value={web.key} onChange={event => update({ key: event.target.value })} placeholder="e.g. Enter or a" />
    </label>}
    {web.trigger === 'animationEnd' && <p className="text-xs text-gray-400">Choose Fade or Slide up above. This event runs after this component's entrance animation.</p>}
    <label className="block text-xs">Action
      <select aria-label="Web action" className={field} value={web.action} onChange={event => update({ action: event.target.value as WebElement['action'], targetId: '', clipIndex: undefined, soundId: undefined })}>
        <option value="none">None</option><option value="scroll">Scroll to element</option><option value="toggle">Show / hide element</option><option value="rotate">Rotate 3D object</option><option value="playClip">Play GLB clip</option><option value="playSound">Play sound</option><option value="scene">Open scene / page</option>
      </select>
    </label>
    {web.action !== 'none' && <label className="block text-xs">Action target
      <select aria-label="Web action target" className={field} value={web.targetId} onChange={event => update({ targetId: event.target.value, clipIndex: undefined, soundId: undefined })}>
        <option value="">Choose target</option>
        {web.action === 'scene' ? scenes.filter(scene => scene.id !== activeSceneId).map(scene =>
          <option key={scene.id} value={scene.id}>{scene.id === activeSceneId ? sceneOptions.name : scene.sceneOptions.name}</option>) :
        sceneObjects.filter(candidate => candidate.id !== item.id && (
          web.action === 'rotate' ? candidate.type !== 'web' :
          web.action === 'playClip' ? candidate.type === 'model' && candidate.object.animations.length > 0 :
          web.action === 'playSound' ? (candidate.properties.sounds?.length ?? 0) > 0 :
          candidate.type === 'web'))
          .map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
      </select>
    </label>}
    {web.action === 'playClip' && actionTarget && <label className="block text-xs">GLB clip (plays once)
      <select aria-label="Web action clip" className={field} value={web.clipIndex ?? ''} onChange={event => update({ clipIndex: event.target.value === '' ? undefined : Number(event.target.value) })}>
        <option value="">Choose clip</option>
        {actionTarget.object.animations.map((clip, index) => <option key={index} value={index}>{clip.name || `Clip ${index + 1}`}</option>)}
      </select>
    </label>}
    {web.action === 'playSound' && actionTarget && <label className="block text-xs">Sound
      <select aria-label="Web action sound" className={field} value={web.soundId ?? ''} onChange={event => update({ soundId: event.target.value || undefined })}>
        <option value="">Choose sound</option>
        {actionTarget.properties.sounds?.map(sound => <option key={sound.id} value={sound.id}>{sound.name}</option>)}
      </select>
    </label>}
    <label className="block text-xs">Custom CSS declarations
      <textarea aria-label="Web custom CSS" className={`${field} font-mono`} rows={4} value={web.customCss ?? ''} onChange={event => update({ customCss: event.target.value })}
        placeholder="color: white; border-radius: 12px;" />
      <span className="text-gray-400">Declarations apply to this component only; selectors and @media rules are not supported.</span>
    </label>
    <label className="block text-xs">Custom JavaScript
      <textarea aria-label="Web script" className={`${field} font-mono`} rows={6} value={web.script} onChange={event => update({ script: event.target.value })}
        placeholder="return { click(event) { ... }, keydown(event) { ... }, scroll(event) { ... } };" />
    </label>
    <p className="text-xs text-gray-400">Available: element, scene, camera, THREE, state, openScene(id), scenes (id and name). Scripts have full browser access.</p>
    <p className="text-xs text-gray-400">Example: openScene(scenes.find(s =&gt; s.name === 'Scene 2 / Page 2').id)</p>
    <button className="rounded bg-red-800 px-3 py-2 text-sm" onClick={() => removeObject(item.id)}>Delete component</button>
  </section>;
}

function validateMedia(kind: 'audio' | 'video', source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const element = document.createElement(kind);
    element.onloadedmetadata = () => resolve();
    element.onerror = () => reject(new Error(`Unsupported or invalid ${kind}`));
    element.src = source;
  });
}
