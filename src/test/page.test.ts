import { afterEach, describe, expect, it } from 'vitest'

import { createDemoApp, DemoApp } from '../demo/main'
import { DEFAULT_COUNT } from '../demo/config'
import { injectStyles } from '../demo/style'

let app: DemoApp | null = null

afterEach(() => {
    if (app) {
        app.destroy()
        app = null
    }
    document.body.innerHTML = ''
})

function mountDemo(search = ''): DemoApp {
    injectStyles()
    const root = document.createElement('div')
    root.id = 'app'
    document.body.appendChild(root)
    app = createDemoApp(root, search)
    return app
}

/** 在场景中找一个没有矩形覆盖的空白点（用于断言“点击空白”） */
function findEmptyPoint(current: DemoApp): { x: number; y: number } {
    const { rects } = current.scene
    const { width, height } = current.scene.layoutSize

    // 逐条水平线扫描：先合并该线上被矩形覆盖的 x 区间，再找空隙
    for (let y = height - 1; y >= 0; y -= 0.5) {
        const spans = rects
            .filter(rect => y >= rect.y && y <= rect.y + rect.height)
            .map(rect => [rect.x, rect.x + rect.width] as [number, number])
            .sort((a, b) => a[0] - b[0])

        let cursor = 0
        for (const [start, end] of spans) {
            if (start > cursor) return { x: cursor + (start - cursor) / 2, y }
            cursor = Math.max(cursor, end)
        }
        if (cursor < width) return { x: cursor + (width - cursor) / 2, y }
    }
    throw new Error('画布上没有空白点')
}

describe('演示页集成：引擎事件与 HUD', () => {
    it('启动后铺开默认数量矩形，HUD 初始为 0 选中 / none', () => {
        const demo = mountDemo()

        expect(demo.scene.rects.length).toBe(DEFAULT_COUNT)
        expect(demo.scene.leafer.children.length).toBe(DEFAULT_COUNT)
        expect(demo.hud.selected.textContent).toBe('0')
        expect(demo.hud.hit.textContent).toBe('none')
        expect(demo.hud.notice.hidden).toBe(true)
    })

    it('点击矩形后 HUD 显示命中 id 与选中数量 1', () => {
        const demo = mountDemo()

        const target = demo.scene.rects[16]
        const state = demo.scene.clickAt(target.x + target.width / 2, target.y + target.height / 2)

        expect(state.hitId).toBe(target.id)
        expect(state.selectedCount).toBe(1)
        expect(demo.hud.selected.textContent).toBe('1')
        expect(demo.hud.hit.textContent).toBe(target.id)
    })

    it('重复点击同一位置，HUD 结果保持一致', () => {
        const demo = mountDemo()

        const target = demo.scene.rects[7]
        const x = target.x + target.width / 2
        const y = target.y + target.height / 2

        demo.scene.clickAt(x, y)
        const first = { selected: demo.hud.selected.textContent, hit: demo.hud.hit.textContent }
        demo.scene.clickAt(x, y)
        demo.scene.clickAt(x, y)
        const second = { selected: demo.hud.selected.textContent, hit: demo.hud.hit.textContent }

        expect(second).toEqual(first)
        expect(second.hit).toBe(target.id)
    })

    it('点击空白后清空选中，命中 id 显示 none', () => {
        const demo = mountDemo()

        const target = demo.scene.rects[3]
        demo.scene.clickAt(target.x + target.width / 2, target.y + target.height / 2)
        expect(demo.hud.selected.textContent).toBe('1')

        const point = findEmptyPoint(demo)
        const empty = demo.scene.clickAt(point.x, point.y)

        expect(empty.selectedCount).toBe(0)
        expect(empty.hitId).toBe('none')
        expect(demo.hud.selected.textContent).toBe('0')
        expect(demo.hud.hit.textContent).toBe('none')
    })

    it('非法 count 回退默认值，并在页面上给出提示而不是白屏', () => {
        const demo = mountDemo('?count=abc')

        expect(demo.scene.rects.length).toBe(DEFAULT_COUNT)
        expect(demo.config.fallback).toBe(true)
        expect(demo.hud.notice.hidden).toBe(false)
        expect(demo.hud.notice.textContent).toContain('abc')
        expect(document.body.textContent).toContain('abc')
    })

    it('超过上限的 count 同样回退并提示', () => {
        const demo = mountDemo('?count=100001')

        expect(demo.scene.rects.length).toBe(DEFAULT_COUNT)
        expect(demo.config.count).toBe(DEFAULT_COUNT)
        expect(demo.hud.notice.hidden).toBe(false)
        expect(demo.hud.notice.textContent).toContain('100001')
    })

    it('合法 count 生效且不显示提示', () => {
        const demo = mountDemo('?count=128')

        expect(demo.scene.rects.length).toBe(128)
        expect(demo.config.fallback).toBe(false)
        expect(demo.hud.notice.hidden).toBe(true)
    })

    it('视口变化后重排，矩形数量不变且节点复用', () => {
        const demo = mountDemo('?count=64')

        const before = demo.scene.leafer.children.length
        demo.scene.leafer.resize({ width: 640, height: 480 })
        demo.scene.relayout()

        expect(demo.scene.layoutSize).toEqual({ width: 640, height: 480 })
        expect(demo.scene.leafer.children.length).toBe(before)
        expect(demo.scene.rects.length).toBe(64)

        // 所有矩形仍落在画布范围内
        for (const rect of demo.scene.rects) {
            expect(rect.x).toBeGreaterThanOrEqual(0)
            expect(rect.y).toBeGreaterThanOrEqual(0)
            expect(rect.x + rect.width).toBeLessThanOrEqual(640)
            expect(rect.y + rect.height).toBeLessThanOrEqual(480)
        }

        // HUD 挂在固定定位的容器上，不会随时间被画布覆盖
        expect(demo.hud.root.parentElement).toBe(document.getElementById('app'))
    })

    it('FPS 指标基于最近 60 帧均值', () => {
        const demo = mountDemo('?count=32')

        // 60fps：每帧 16.67ms
        for (let i = 0; i < 61; i++) demo.sampleFrame(i * (1000 / 60))
        expect(demo.hud.fps.textContent).toBe('60.0')

        // 掉帧到 30fps 后，均值逐渐收敛
        let time = 61 * (1000 / 60)
        for (let i = 0; i < 60; i++) {
            time += 1000 / 30
            demo.sampleFrame(time)
        }
        const fps = Number(demo.hud.fps.textContent)
        expect(fps).toBeGreaterThan(29)
        expect(fps).toBeLessThan(31)
    })

    it('非法帧时间不会污染指标', () => {
        const demo = mountDemo('?count=8')
        demo.sampleFrame(Number.NaN)
        expect(demo.hud.fps.textContent).toBe('0.0')
    })

    it('拖拽同步后点击新位置命中该矩形，点击旧位置落空或命中其他矩形', () => {
        const demo = mountDemo('?count=1')
        const drag = demo.scene.rects[0]

        expect(drag.draggable).toBe(true)
        const state = demo.scene.clickAt(drag.x + drag.width / 2, drag.y + drag.height / 2)
        expect(state.hitId).toBe(drag.id)
    })
})
