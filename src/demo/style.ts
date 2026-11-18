const CSS = `
* { box-sizing: border-box; }

html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #f4f6fb;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    color: #1b2130;
}

#app {
    position: relative;
    width: 100%;
    height: 100%;
}

#stage {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
}

.demo-hud {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 9999;
    min-width: 248px;
    padding: 14px 16px;
    border-radius: 12px;
    background: rgba(23, 29, 43, 0.9);
    color: #ffffff;
    box-shadow: 0 8px 28px rgba(18, 24, 38, 0.28);
    font-size: 13px;
    line-height: 1.5;
    pointer-events: none;
}

.demo-hud__row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    padding: 3px 0;
}

.demo-hud__label {
    color: #a9b4c9;
    white-space: nowrap;
}

.demo-hud__value {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: 15px;
    color: #7cf5b1;
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.demo-hud__notice {
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(255, 196, 61, 0.16);
    border: 1px solid rgba(255, 196, 61, 0.5);
    color: #ffd97a;
    font-size: 12px;
    line-height: 1.45;
}

.demo-hud__notice[hidden] { display: none; }

@media (max-width: 560px) {
    .demo-hud {
        top: 10px;
        right: 10px;
        left: 10px;
        min-width: 0;
    }
}
`

/** 注入演示页样式（字符串形式提供，便于 rollup / vitest 统一处理） */
export function injectStyles(doc: Document = document): void {
    if (doc.getElementById('leafer-demo-style')) return
    const style = doc.createElement('style')
    style.id = 'leafer-demo-style'
    style.textContent = CSS
    doc.head.appendChild(style)
}

/**
 * 确保演示页的挂载节点存在：
 * - #app 作为 HUD 与画布的容器；
 * - #stage 作为画布宿主（占满 #app）。
 * 宿主 HTML 里已有这些节点时直接复用。
 */
export function ensureMount(doc: Document = document): { root: HTMLElement; stage: HTMLElement } {
    let root = doc.getElementById('app')
    if (!root) {
        root = doc.createElement('div')
        root.id = 'app'
        doc.body.appendChild(root)
    }

    let stage = doc.getElementById('stage')
    if (!stage) {
        stage = doc.createElement('div')
        stage.id = 'stage'
        root.appendChild(stage)
    }

    return { root, stage }
}
