export type WebElementKind = 'section' | 'columns' | 'container' | 'card' | 'slider' | 'slide' | 'heading' | 'text' | 'button' | 'menu' | 'image' | 'video' | 'audio' | 'lottie';
export type WebAction = 'none' | 'scroll' | 'toggle' | 'rotate' | 'playClip' | 'playSound' | 'scene';
export type WebTrigger = 'click' | 'key' | 'scroll' | 'animationEnd';
export type WebAnimation = 'none' | 'fade' | 'slide';
export type WebStyleOverride = 'color' | 'fontSize' | 'padding' | 'width' | 'height' | 'borderRadius' | 'margin';

export type WebResponsiveStyle = Partial<Pick<WebElement, 'background' | 'color' | 'fontSize' | 'padding' |
  'margin' | 'borderRadius' | 'columns' | 'fullScreen' | 'backgroundMode' | 'gradientFrom' | 'gradientTo' |
  'gradientAngle' | 'fontFamily' | 'fontWeight' | 'lineHeight' | 'letterSpacing' | 'textAlign' |
  'layoutDirection' | 'alignItems' | 'justifyContent' | 'minHeightVh' | 'maxWidth' | 'gap' | 'pointerMode' | 'styleOverrides'>> &
  { width?: number | null; height?: number | null };

export interface WebElement {
  kind: WebElementKind;
  parentId: string | null;
  text: string;
  image: string;
  background: string;
  color: string;
  fontSize: number;
  padding: number;
  margin?: [number, number, number, number];
  borderRadius?: number;
  width?: number;
  height?: number;
  columns: number;
  fullScreen?: boolean;
  backgroundMode?: 'legacy' | 'transparent' | 'solid' | 'gradient';
  gradientFrom?: string;
  gradientTo?: string;
  gradientAngle?: number;
  fontFamily?: 'system-ui' | 'serif' | 'monospace';
  fontWeight?: number;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: 'left' | 'center' | 'right';
  layoutDirection?: 'default' | 'row' | 'column';
  alignItems?: 'start' | 'center' | 'end' | 'stretch';
  justifyContent?: 'start' | 'center' | 'end' | 'space-between';
  minHeightVh?: number;
  maxWidth?: number;
  gap?: number;
  pointerMode?: 'auto' | 'pass-through';
  styleOverrides?: WebStyleOverride[];
  backgroundImage?: string;
  backgroundVideo?: string;
  video?: string;
  videoAutoPlay?: boolean;
  videoMuted?: boolean;
  videoLoop?: boolean;
  videoControls?: boolean;
  audio?: string;
  audioAutoPlay?: boolean;
  audioLoop?: boolean;
  audioControls?: boolean;
  lottieData?: string;
  animation: WebAnimation;
  animationTrigger: 'load' | 'scroll';
  trigger: WebTrigger;
  key: string;
  action: WebAction;
  targetId: string;
  clipIndex?: number;
  soundId?: string;
  script: string;
  customCss?: string;
  responsiveStyles?: { tablet?: WebResponsiveStyle; mobile?: WebResponsiveStyle };
}

export function newWebElement(kind: WebElementKind, parentId: string | null): WebElement {
  const text: Record<WebElementKind, string> = {
    section: 'Section', columns: 'Columns', container: 'Container', card: 'Card', slider: 'Slider', slide: 'Slide', heading: 'Your heading', text: 'Write your text here.',
    button: 'Click here', menu: 'Menu', image: 'Image', video: 'Video', audio: 'Audio', lottie: 'Animation'
  };
  return {
    kind, parentId, text: text[kind], image: '', background: 'transparent',
    color: '#ffffff', fontSize: kind === 'heading' ? 40 : 16, padding: kind === 'section' ? 32 : kind === 'slider' || kind === 'slide' ? 0 : 12, margin: [0, 0, 0, 0],
    columns: 2, animation: 'none', animationTrigger: 'load', trigger: 'click', key: '', action: 'none', targetId: '', script: ''
  };
}

export function isWebContainer(kind: string): boolean {
  return ['section', 'columns', 'container', 'card', 'menu', 'slider', 'slide'].includes(kind);
}

export function isValidWebParent(kind: WebElementKind, parentKind?: WebElementKind): boolean {
  if (kind === 'slide') return parentKind === 'slider';
  return !parentKind || (isWebContainer(parentKind) && parentKind !== 'slider');
}
