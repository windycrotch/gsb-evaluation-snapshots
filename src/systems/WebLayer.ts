import type * as Three from 'three';
import type { SceneObject } from '../types/editor';
import type { AnimationItem } from 'lottie-web';

type WebHandlers = {
  start?: () => void;
  click?: (event: MouseEvent) => void;
  keydown?: (event: KeyboardEvent) => void;
  scroll?: (event: Event) => void;
  stop?: () => void;
};

interface WebLayerOptions {
  editing: boolean;
  width: string;
  previewDevice?: 'desktop' | 'tablet' | 'mobile';
  selectedId?: string;
  scene: Three.Scene;
  camera: Three.Camera;
  three: typeof Three;
  lottie?: Pick<typeof import('lottie-web').default, 'loadAnimation'>;
  onSelect?: (id: string) => void;
  onMove?: (id: string, targetId: string) => void;
  onPlayClip?: (id: string, clipIndex: number) => void;
  timelineSounds?: { targetId: string; soundId: string }[];
  onSceneChange?: (id: string) => void;
  scenes?: { id: string; name: string }[];
  onError: (message: string) => void;
}

export function createWebLayer(host: HTMLElement, objects: SceneObject[], options: WebLayerOptions) {
  const webObjects = objects.filter(item => item.type === 'web' && item.properties.web);
  const byId = new Map(webObjects.map(item => [item.id, item]));
  const items = webObjects.filter(item => {
    let current: SceneObject | undefined = item;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (!current.object.visible) return false;
      seen.add(current.id);
      current = current.properties.web?.parentId ? byId.get(current.properties.web.parentId) : undefined;
    }
    return true;
  });
  if (!items.length) return () => {};
  const abort = new AbortController();
  const root = document.createElement('div');
  root.className = 'engine-web-root';
  root.style.width = options.width;
  const style = document.createElement('style');
  style.textContent = `
    .engine-web-root{position:absolute;inset:0 auto 0 50%;transform:translateX(-50%);max-width:100%;height:100%;container-type:inline-size;pointer-events:none;z-index:20}
    .engine-web-scroll{height:100%;overflow:auto;overscroll-behavior:contain;pointer-events:none}
    .engine-web-content{min-height:100%;pointer-events:none}
    .engine-web-node{box-sizing:border-box;pointer-events:auto;position:relative}
    .engine-web-section{min-height:45vh}
    .engine-web-columns{display:grid;grid-template-columns:repeat(var(--web-columns),minmax(0,1fr));gap:16px}
    .engine-web-container{display:grid;grid-template-columns:repeat(var(--web-columns),minmax(0,1fr));gap:16px}
    .engine-web-menu{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
    .engine-web-slider{overflow:hidden}
    .engine-web-slide{min-height:45vh;overflow:hidden}
    .engine-web-slider[data-full-screen="true"]>.engine-web-slide{min-height:100vh}
    .engine-web-background-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none}
    .engine-web-slide>.engine-web-node{z-index:1}
    .engine-web-slider-controls{position:absolute;inset:auto 12px 12px auto;display:flex;gap:8px;z-index:2;pointer-events:auto}
    .engine-web-slider-controls button{border:0;border-radius:6px;background:#1e293bcc;color:white;padding:10px 14px;cursor:pointer}
    .engine-web-edit .engine-web-slide::before{content:attr(data-label);display:block;font:12px sans-serif;color:#cbd5e1}
    .engine-web-button{border:0;border-radius:6px;cursor:pointer}
    .engine-web-image,.engine-web-video{display:block;max-width:100%;height:auto}
    .engine-web-lottie{width:100%;min-height:40px}
    .engine-web-node[hidden]{display:none!important}
    .engine-web-edit .engine-web-node{outline:1px dashed #8ca3b3;cursor:pointer;min-height:36px}
    .engine-web-edit .engine-web-node[data-selected="true"]{outline:2px solid #38bdf8}
    .engine-web-edit .engine-web-node:empty::after{content:attr(data-label);font:12px sans-serif;color:#cbd5e1}
    .engine-web-node[data-animation="fade"]{animation:engine-web-fade .8s both}
    .engine-web-node[data-animation="slide"]{animation:engine-web-slide .8s both}
    @keyframes engine-web-fade{from{opacity:0}to{opacity:1}}
    @keyframes engine-web-slide{from{opacity:0;transform:translateY(25px)}to{opacity:1;transform:translateY(0)}}
    @container (max-width:700px){.engine-web-columns:not([data-layout-columns="custom"]){grid-template-columns:1fr}.engine-web-node[data-kind="heading"]:not([data-layout-font="custom"]){font-size:min(var(--web-font-size),32px)!important}}
    @container (max-width:1024px){.engine-web-container{grid-template-columns:repeat(var(--web-columns-medium),minmax(0,1fr))}}
    @container (max-width:480px){.engine-web-container:not([data-layout-columns="custom"]){grid-template-columns:1fr}}
    @media (orientation:portrait) and (max-width:767px){.engine-web-container:not([data-layout-columns="custom"]){grid-template-columns:1fr}}
    @media (prefers-reduced-motion:reduce){.engine-web-node{animation:none!important;scroll-behavior:auto!important}}
  `;
  const scroll = document.createElement('div');
  scroll.className = 'engine-web-scroll';
  const content = document.createElement('div');
  content.className = `engine-web-content${options.editing ? ' engine-web-edit' : ''}`;
  scroll.appendChild(content);
  root.append(style, scroll);
  host.appendChild(root);
  const elements = new Map<string, HTMLElement>();
  const handlers: WebHandlers[] = [];
  const observers: IntersectionObserver[] = [];
  const animations: AnimationItem[] = [];
  const reducedMotionCompletions = new Map<HTMLElement, () => void>();
  const videos: HTMLVideoElement[] = [];
  const audios: HTMLAudioElement[] = [];
  const actionSounds = new Map<string, HTMLAudioElement>();
  const visualProperties = new Map<HTMLElement, string[]>();
  const canvas = host.parentElement?.querySelector('canvas');

  if (!options.editing && canvas) {
    let touchY: number | null = null;
    canvas.addEventListener('wheel', event => {
      if (scroll.scrollHeight <= scroll.clientHeight) return;
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroll.clientHeight : 1;
      scroll.scrollTop += event.deltaY * factor;
      event.preventDefault();
    }, { passive: false, signal: abort.signal });
    canvas.addEventListener('touchstart', event => {
      touchY = event.touches.length === 1 ? event.touches[0].clientY : null;
    }, { passive: true, signal: abort.signal });
    canvas.addEventListener('touchmove', event => {
      if (touchY === null || event.touches.length !== 1 || scroll.scrollHeight <= scroll.clientHeight) return;
      const next = event.touches[0].clientY;
      scroll.scrollTop += touchY - next;
      touchY = next;
      event.preventDefault();
    }, { passive: false, signal: abort.signal });
  }

  for (const item of items) {
    const config = item.properties.web!;
    const tag = config.kind === 'heading' ? 'h2' : config.kind === 'text' ? 'p' :
      config.kind === 'button' ? 'button' : config.kind === 'menu' ? 'nav' :
      config.kind === 'image' ? 'img' : config.kind === 'video' ? 'video' : config.kind === 'audio' ? 'audio' : 'section';
    const element = document.createElement(tag);
    element.className = `engine-web-node engine-web-${config.kind} ${item.properties.className ?? ''}`;
    element.dataset.webId = item.id;
    element.dataset.tags = (item.properties.tags ?? []).join(',');
    element.dataset.kind = config.kind;
    element.dataset.label = item.name;
    element.dataset.selected = String(item.id === options.selectedId);
    if (config.kind === 'slider') {
      element.setAttribute('aria-roledescription', 'carousel');
    }
    if (config.kind === 'slide' && config.backgroundImage) {
      element.style.backgroundImage = `url("${config.backgroundImage.replace(/["\\\n\r]/g, '')}")`;
      element.style.backgroundSize = 'cover';
      element.style.backgroundPosition = 'center';
    }
    if (config.kind === 'slide' && config.backgroundVideo) {
      const video = document.createElement('video');
      video.className = 'engine-web-background-video';
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('aria-hidden', 'true');
      video.addEventListener('error', () => options.onError(`${item.name}: failed to load background video`), { signal: abort.signal });
      video.src = config.backgroundVideo;
      element.appendChild(video);
      videos.push(video);
    }
    if (tag === 'button') (element as HTMLButtonElement).type = 'button';
    if (tag === 'img') {
      const image = element as HTMLImageElement;
      if (config.image) image.src = config.image;
      image.alt = config.text;
    } else if (tag === 'video') {
      const video = element as HTMLVideoElement;
      video.setAttribute('aria-label', config.text);
      video.controls = config.videoControls ?? true;
      video.muted = config.videoMuted ?? true;
      video.loop = config.videoLoop ?? true;
      video.autoplay = config.videoAutoPlay ?? true;
      video.playsInline = true;
      if (config.video) {
        video.addEventListener('error', () => options.onError(`${item.name}: failed to load video`), { signal: abort.signal });
        video.src = config.video;
      }
      videos.push(video);
    } else if (tag === 'audio') {
      const audio = element as HTMLAudioElement;
      audio.setAttribute('aria-label', config.text);
      audio.controls = config.audioControls ?? true;
      audio.loop = config.audioLoop ?? false;
      audio.dataset.autoPlay = String(config.audioAutoPlay ?? false);
      if (config.audio) {
        audio.addEventListener('error', () => options.onError(`${item.name}: failed to load audio`), { signal: abort.signal });
        audio.src = config.audio;
      }
      audios.push(audio);
    } else if (!['section', 'columns', 'container', 'card', 'menu', 'slider', 'slide', 'lottie'].includes(config.kind)) {
      element.textContent = config.text;
    } else {
      element.setAttribute('aria-label', config.text);
    }
    if (!options.editing && config.animation !== 'none' && config.animationTrigger !== 'scroll') element.dataset.animation = config.animation;
    elements.set(item.id, element);
  }

  const applyResponsiveStyles = () => {
    const device = options.editing && options.previewDevice ? options.previewDevice :
      window.innerWidth <= 767 ? 'mobile' : window.innerWidth <= 1024 ? 'tablet' : 'desktop';
    for (const item of items) {
      const config = item.properties.web!;
      const element = elements.get(item.id)!;
      const variant = device === 'desktop' ? undefined : config.responsiveStyles?.[device];
      const layout = { ...config, ...variant };
      visualProperties.get(element)?.forEach(property => element.style.removeProperty(property));
      const applied: string[] = [];
      visualProperties.set(element, applied);
      element.style.pointerEvents = !options.editing &&
        ['section', 'columns', 'container', 'card', 'menu', 'slider', 'slide'].includes(config.kind) &&
        !(config.trigger === 'click' && config.action !== 'none') && !config.script.trim() ? 'none' : '';
      element.style.background = layout.background;
      if (config.kind === 'slide' && config.backgroundImage) {
        element.style.backgroundImage = `url("${config.backgroundImage.replace(/["\\\n\r]/g, '')}")`;
        element.style.backgroundSize = 'cover';
        element.style.backgroundPosition = 'center';
      }
      element.style.color = layout.color;
      element.style.fontSize = `${layout.fontSize}px`;
      element.style.setProperty('--web-font-size', `${layout.fontSize}px`);
      element.style.padding = `${layout.padding}px`;
      element.style.width = layout.width == null ? '' : `${layout.width}px`;
      element.style.maxWidth = layout.width == null ? '' : '100%';
      element.style.height = layout.height == null ? '' : `${layout.height}px`;
      element.style.borderRadius = layout.borderRadius === undefined ? '' : `${layout.borderRadius}px`;
      element.style.margin = layout.margin ? layout.margin.map(value => `${value}px`).join(' ') : '';
      element.style.setProperty('--web-columns', String(layout.columns));
      element.style.setProperty('--web-columns-medium', String(variant?.columns === undefined
        ? Math.max(1, Math.floor(layout.columns / 2)) : layout.columns));
      element.dataset.layoutColumns = variant?.columns === undefined ? '' : 'custom';
      element.dataset.layoutFont = variant?.fontSize === undefined ? '' : 'custom';
      if (config.kind === 'slider') {
        element.dataset.fullScreen = String(layout.fullScreen ?? false);
        element.style.minHeight = layout.fullScreen ? '100vh' : '';
      }
      if (config.customCss) element.style.cssText += `;${config.customCss}`;
      if (layout.backgroundMode && layout.backgroundMode !== 'legacy') {
        const background = layout.backgroundMode === 'transparent' ? 'transparent' :
          layout.backgroundMode === 'gradient'
            ? `linear-gradient(${layout.gradientAngle ?? 90}deg, ${layout.gradientFrom ?? '#0b1220'}, ${layout.gradientTo ?? '#64748b'})`
            : layout.background;
        element.style.setProperty('background', background, 'important');
      }
      const setVisual = (property: string, value: string | undefined) => {
        if (value !== undefined) {
          element.style.setProperty(property, value, 'important');
          applied.push(property);
        }
      };
      for (const property of layout.styleOverrides ?? []) {
        switch (property) {
          case 'color': setVisual('color', layout.color); break;
          case 'fontSize': setVisual('font-size', `${layout.fontSize}px`); break;
          case 'padding': setVisual('padding', `${layout.padding}px`); break;
          case 'width': setVisual('width', layout.width == null ? 'auto' : `${layout.width}px`); break;
          case 'height': setVisual('height', layout.height == null ? 'auto' : `${layout.height}px`); break;
          case 'borderRadius': setVisual('border-radius', `${layout.borderRadius ?? 0}px`); break;
          case 'margin': setVisual('margin', (layout.margin ?? [0, 0, 0, 0]).map(value => `${value}px`).join(' ')); break;
        }
      }
      setVisual('font-family', layout.fontFamily);
      setVisual('font-weight', layout.fontWeight === undefined ? undefined : String(layout.fontWeight));
      setVisual('line-height', layout.lineHeight === undefined ? undefined : String(layout.lineHeight));
      setVisual('letter-spacing', layout.letterSpacing === undefined ? undefined : `${layout.letterSpacing}px`);
      setVisual('text-align', layout.textAlign);
      if (layout.layoutDirection && layout.layoutDirection !== 'default') {
        setVisual('display', 'flex');
        setVisual('flex-direction', layout.layoutDirection);
      }
      setVisual('align-items', layout.alignItems);
      setVisual('justify-content', layout.justifyContent);
      setVisual('min-height', layout.minHeightVh === undefined ? undefined : `${layout.minHeightVh}vh`);
      setVisual('max-width', layout.maxWidth === undefined ? undefined : `${layout.maxWidth}px`);
      setVisual('gap', layout.gap === undefined ? undefined : `${layout.gap}px`);
      if (layout.pointerMode) setVisual('pointer-events', layout.pointerMode === 'pass-through' ? 'none' : 'auto');
    }
  };
  applyResponsiveStyles();
  window.addEventListener('resize', applyResponsiveStyles, { signal: abort.signal });

  for (const item of items) {
    const config = item.properties.web!;
    const element = elements.get(item.id)!;
    const parent = config.parentId ? elements.get(config.parentId) : undefined;
    if (parent && ['section', 'columns', 'container', 'card', 'menu', 'slider', 'slide'].includes(parent.dataset.kind || '')) parent.appendChild(element);
    else content.appendChild(element);

    if (config.kind === 'lottie' && config.lottieData) {
      try {
        if (!options.lottie) throw new Error('Lottie player is unavailable');
        const animation = options.lottie.loadAnimation({
          container: element, renderer: 'svg', loop: true, autoplay: true,
          animationData: JSON.parse(config.lottieData)
        });
        animation.addEventListener('data_failed', () => options.onError(`${item.name}: failed to load Lottie animation`));
        animation.addEventListener('error', () => options.onError(`${item.name}: failed to render Lottie animation`));
        animations.push(animation);
      } catch (error) {
        options.onError(`${item.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (options.editing) {
      element.draggable = true;
      element.addEventListener('click', event => { event.stopPropagation(); options.onSelect?.(item.id); }, { signal: abort.signal });
      element.addEventListener('dragstart', event => {
        event.stopPropagation();
        event.dataTransfer?.setData('text/plain', item.id);
      }, { signal: abort.signal });
      element.addEventListener('dragover', event => { event.preventDefault(); event.stopPropagation(); }, { signal: abort.signal });
      element.addEventListener('drop', event => {
        event.preventDefault(); event.stopPropagation();
        const id = event.dataTransfer?.getData('text/plain');
        if (id && id !== item.id) options.onMove?.(id, item.id);
      }, { signal: abort.signal });
      continue;
    }
    if (config.animation !== 'none' && config.animationTrigger === 'scroll') {
      const observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          element.dataset.animation = config.animation;
          reducedMotionCompletions.get(element)?.();
          observer.disconnect();
        }
      }, { root: scroll, threshold: 0.1 });
      observer.observe(element);
      observers.push(observer);
    }

    const runAction = () => {
      if (element.closest('.engine-web-slide[hidden]')) return;
      const target = elements.get(config.targetId);
      if (config.action === 'scene') {
        if (config.targetId && options.onSceneChange) options.onSceneChange(config.targetId);
        else options.onError(`${item.name}: select an existing scene`);
      }
      else if (config.action === 'scroll' && target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else if (config.action === 'toggle' && target) target.hidden = !target.hidden;
      else if (config.action === 'rotate') {
        const object = objects.find(candidate => candidate.id === config.targetId)?.object;
        if (object) object.rotation.y += Math.PI / 4;
        else options.onError(`${item.name}: select an existing 3D target`);
      }
      else if (config.action === 'playClip') {
        if (config.targetId && config.clipIndex !== undefined && options.onPlayClip) {
          options.onPlayClip(config.targetId, config.clipIndex);
        } else options.onError(`${item.name}: select a model and animation clip`);
      }
      else if (config.action === 'playSound') {
        if (options.timelineSounds?.some(segment => segment.targetId === config.targetId && segment.soundId === config.soundId)) {
          options.onError(`${item.name}: this sound is controlled by the timeline`);
          return;
        }
        const sound = objects.find(candidate => candidate.id === config.targetId)?.properties.sounds?.find(value => value.id === config.soundId);
        if (!sound) {
          options.onError(`${item.name}: select an existing sound`);
          return;
        }
        let audio = actionSounds.get(sound.id);
        if (!audio) {
          audio = new Audio(sound.url);
          audio.volume = sound.volume;
          audio.loop = sound.loop;
          actionSounds.set(sound.id, audio);
        }
        audio.currentTime = 0;
        void audio.play().catch(error => options.onError(`${item.name}: ${error instanceof Error ? error.message : String(error)}`));
      }
      else if (config.action !== 'none') options.onError(`${item.name}: select an existing web target`);
    };
    let script: WebHandlers = {};
    if (config.script.trim()) {
      try {
        const create = new Function('element', 'scene', 'camera', 'THREE', 'state', 'openScene', 'scenes', config.script);
        const result: unknown = create(element, options.scene, options.camera, options.three, {}, options.onSceneChange, options.scenes ?? []);
        if (!result || typeof result !== 'object') throw new Error('Script must return an object');
        script = result as WebHandlers;
        handlers.push(script);
        script.start?.();
      } catch (error) {
        options.onError(`${item.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const invoke = (method: 'click' | 'keydown' | 'scroll', event: Event) => {
      if (element.closest('.engine-web-slide[hidden]')) return;
      try {
        const callback = script[method];
        if (callback) callback.call(script, event as MouseEvent & KeyboardEvent);
      } catch (error) {
        options.onError(`${item.name} (${method}): ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    element.addEventListener('click', event => {
      if (config.trigger === 'click') runAction();
      invoke('click', event);
    }, { signal: abort.signal });
    element.addEventListener('animationend', event => {
      if (config.trigger === 'animationEnd' && event.target === element &&
          event.animationName === `engine-web-${config.animation}`) runAction();
    }, { signal: abort.signal });
    if (config.trigger === 'animationEnd' && config.animation !== 'none' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      let completed = false;
      const complete = () => {
        if (completed || abort.signal.aborted || !element.dataset.animation || element.closest('.engine-web-slide[hidden]')) return;
        completed = true;
        runAction();
      };
      reducedMotionCompletions.set(element, complete);
      requestAnimationFrame(complete);
    }
    window.addEventListener('keydown', event => {
      if (config.trigger === 'key' && config.key && event.key.toLowerCase() === config.key.toLowerCase()) runAction();
      invoke('keydown', event);
    }, { signal: abort.signal });
    let wasScrolled = false;
    scroll.addEventListener('scroll', event => {
      const scrolled = scroll.scrollTop > 40;
      if (config.trigger === 'scroll' && scrolled && !wasScrolled) runAction();
      wasScrolled = scrolled;
      invoke('scroll', event);
    }, { signal: abort.signal });
  }
  for (const item of items) {
    const config = item.properties.web!;
    const element = elements.get(item.id)!;
    if (config.kind !== 'slider') continue;
    const slides = Array.from(element.children).filter((child): child is HTMLElement =>
      child instanceof HTMLElement && child.dataset.kind === 'slide');
    if (options.editing || slides.length === 0) continue;
    let active = 0;
    const controls = document.createElement('div');
    controls.className = 'engine-web-slider-controls';
    const previous = document.createElement('button');
    previous.type = 'button';
    previous.setAttribute('aria-label', 'Previous slide');
    previous.textContent = 'Previous';
    const next = document.createElement('button');
    next.type = 'button';
    next.setAttribute('aria-label', 'Next slide');
    next.textContent = 'Next';
    controls.append(previous, next);
    if (slides.length > 1) element.appendChild(controls);
    const show = (index: number) => {
      active = (index + slides.length) % slides.length;
      slides.forEach((slide, slideIndex) => {
        const visible = slideIndex === active;
        slide.hidden = !visible;
        slide.setAttribute('aria-hidden', String(!visible));
        slide.querySelectorAll<HTMLMediaElement>('video, audio').forEach(media => {
          if (!visible) media.pause();
          else if (!media.closest('.engine-web-slide[hidden]') &&
                   ((media instanceof HTMLVideoElement && media.autoplay) ||
                    (media instanceof HTMLAudioElement && media.dataset.autoPlay === 'true'))) {
            if (media.currentSrc || media.getAttribute('src')) void media.play().catch(error => {
              if (abort.signal.aborted || media.closest('.engine-web-slide[hidden]')) return;
              options.onError(`${item.name}: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        });
      });
      slides[active].querySelectorAll<HTMLElement>('.engine-web-node').forEach(node => reducedMotionCompletions.get(node)?.());
      reducedMotionCompletions.get(slides[active])?.();
    };
    previous.addEventListener('click', event => { event.stopPropagation(); show(active - 1); }, { signal: abort.signal });
    next.addEventListener('click', event => { event.stopPropagation(); show(active + 1); }, { signal: abort.signal });
    element.addEventListener('keydown', event => {
      if (event.target instanceof Element && event.target.closest('input,textarea,select')) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        show(active + (event.key === 'ArrowRight' ? 1 : -1));
      }
    }, { signal: abort.signal });
    let startX: number | null = null;
    element.addEventListener('touchstart', event => {
      startX = event.touches.length === 1 ? event.touches[0].clientX : null;
    }, { passive: true, signal: abort.signal });
    element.addEventListener('touchend', event => {
      if (startX !== null && event.changedTouches.length === 1) {
        const distance = event.changedTouches[0].clientX - startX;
        if (Math.abs(distance) > 50) show(active + (distance < 0 ? 1 : -1));
      }
      startX = null;
    }, { passive: true, signal: abort.signal });
    show(0);
  }
  if (!options.editing) {
    for (const audio of audios) {
      if (audio.dataset.autoPlay === 'true' && !audio.closest('.engine-web-slide') && audio.src) {
        void audio.play().catch(error => options.onError(error instanceof Error ? error.message : String(error)));
      }
    }
  }
  return () => {
    abort.abort();
    animations.forEach(animation => animation.destroy());
    videos.forEach(video => video.pause());
    audios.forEach(audio => audio.pause());
    actionSounds.forEach(audio => { audio.pause(); audio.currentTime = 0; });
    observers.forEach(observer => observer.disconnect());
    for (const script of handlers) {
      try { script.stop?.(); } catch (error) {
        options.onError(`Web script (stop): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    root.remove();
  };
}
