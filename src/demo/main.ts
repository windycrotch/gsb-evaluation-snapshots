import { MAX_COUNT, parseCount } from './config'
import { FpsMeter } from './fps'
import { createHud, showNotice, updateFps, updateSelection, HudElements } from './hud'
import { createScene, Scene } from './scene'
import { ensureMount, injectStyles } from './style'

/**
 * 性能与命中演示页。
 *
 * 指标：
 * - 最近 60 帧的平均帧率
 * - 当前选中矩形数量（0 或 1）
 * - 最近一次点击命中的矩形 id（未命中为 none）
 *
 * 交互：
 * - 一个矩形可拖拽；点击矩形只选中它，点击空白清空选中
 * - URL 参数 count 控制矩形数量（默认 20000，上限 100000）
 * - count 非法时回退默认值，并在页面提示
 * - 窗口缩放时画布与布局自适应，HUD 固定右上角不被遮挡
 */

export interface DemoApp {
    scene: Scene
    hud: HudElements
    fpsMeter: FpsMeter
    config: { count: number; fallback: boolean; max: number }
    /** 推进一帧帧率采样（浏览器里由 rAF 驱动，测试可直接调用） */
    sampleFrame(time: number): void
    destroy(): void
}

/** 在给定容器中构建演示页（不依赖 location，便于测试） */
export function createDemoApp(root: HTMLElement, search: string): DemoApp {
    const { stage } = ensureMount(root.ownerDocument)

    const hud = createHud(root)

    const { count, fallback, message } = parseCount(new URLSearchParams(search).get('count'))
    if (fallback && message) showNotice(hud, message)

    const fpsMeter = new FpsMeter(60)
    const scene = createScene(stage, { count })

    const unsubscribe = scene.controller.model.onChange(state => updateSelection(hud, state))
    updateSelection(hud, scene.controller.state)

    function sampleFrame(time: number): void {
        fpsMeter.record(time)
        const fps = fpsMeter.average
        if (fps > 0) updateFps(hud, fps)
    }

    return {
        scene,
        hud,
        fpsMeter,
        config: { count, fallback, max: MAX_COUNT },
        sampleFrame,
        destroy() {
            unsubscribe()
            scene.destroy()
            hud.root.remove()
        }
    }
}

/** 启动演示页：注入样式、挂载节点，并开始逐帧统计 FPS */
export function boot(search: string = location.search): DemoApp {
    injectStyles()
    const { root } = ensureMount()

    const app = createDemoApp(root, search)

    // 帧率按浏览器帧节拍统计：渲染阻塞主线程时帧间隔会变大，指标随之下降。
    // 注意不要在每帧里强制请求渲染，否则会和引擎自身的渲染调度叠加、压低真实帧率。
    // 首帧只用于建立基准，不参与统计，避免把建场景时的长帧计入均值。
    let rafId = 0
    let warmedUp = false
    function frame(time: number): void {
        if (warmedUp) app.sampleFrame(time)
        else warmedUp = true
        rafId = requestAnimationFrame(frame)
    }
    rafId = requestAnimationFrame(frame)

    // --- 自适应：视口变化后按新尺寸重排；HUD 位于 fixed 层，不遮挡指标 ---
    let resizeTimer = 0
    function onResize(): void {
        clearTimeout(resizeTimer)
        resizeTimer = window.setTimeout(() => app.scene.relayout(), 120)
    }
    window.addEventListener('resize', onResize)

    const destroy = app.destroy
    app.destroy = () => {
        cancelAnimationFrame(rafId)
        clearTimeout(resizeTimer)
        window.removeEventListener('resize', onResize)
        destroy()
    }

    // 便于调试与自动化测试
    ;(window as unknown as { __demo?: DemoApp }).__demo = app

    return app
}
