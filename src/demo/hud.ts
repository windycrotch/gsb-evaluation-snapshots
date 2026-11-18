import { formatFps } from './fps'
import { SelectionState } from './selection'

export interface HudElements {
    /** HUD 容器（悬于画布之上） */
    root: HTMLElement
    fps: HTMLElement
    selected: HTMLElement
    hit: HTMLElement
    notice: HTMLElement
}

/** 在页面右上角创建指标面板。fixed + 高 z-index，保证缩放窗口时不被画布遮挡。 */
export function createHud(root: HTMLElement): HudElements {
    const hud = document.createElement('div')
    hud.className = 'demo-hud'
    hud.setAttribute('role', 'status')
    hud.setAttribute('aria-live', 'polite')
    hud.innerHTML = `
        <div class="demo-hud__row"><span class="demo-hud__label">FPS（最近 60 帧均值）</span><span class="demo-hud__value" data-fps>0.0</span></div>
        <div class="demo-hud__row"><span class="demo-hud__label">选中数量</span><span class="demo-hud__value" data-selected>0</span></div>
        <div class="demo-hud__row"><span class="demo-hud__label">命中矩形 id</span><span class="demo-hud__value" data-hit>none</span></div>
        <div class="demo-hud__notice" data-notice hidden></div>
    `
    root.appendChild(hud)

    const pick = (selector: string): HTMLElement => hud.querySelector(selector) as HTMLElement

    return {
        root: hud,
        fps: pick('[data-fps]'),
        selected: pick('[data-selected]'),
        hit: pick('[data-hit]'),
        notice: pick('[data-notice]')
    }
}

export function updateFps(hud: HudElements, fps: number): void {
    const text = formatFps(fps)
    if (hud.fps.textContent !== text) hud.fps.textContent = text
}

export function updateSelection(hud: HudElements, state: SelectionState): void {
    const selected = String(state.selectedCount)
    if (hud.selected.textContent !== selected) hud.selected.textContent = selected
    if (hud.hit.textContent !== state.hitId) hud.hit.textContent = state.hitId
}

export function showNotice(hud: HudElements, message?: string): void {
    if (message) {
        hud.notice.textContent = message
        hud.notice.hidden = false
    } else {
        hud.notice.textContent = ''
        hud.notice.hidden = true
    }
}
