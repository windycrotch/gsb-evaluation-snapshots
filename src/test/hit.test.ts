import { describe, expect, it } from 'vitest'

import { HitController } from '../demo/controller'
import { CLICK_RECT_ID, createLayout, DRAG_RECT_ID, hitTest } from '../demo/layout'

function inside(rect: { x: number; y: number; width: number; height: number }) {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

describe('命中判定', () => {
    it('所有矩形 id 稳定且唯一', () => {
        const rects = createLayout(500, 1280, 720)
        const ids = rects.map(item => item.id)
        expect(ids.length).toBe(500)
        expect(new Set(ids).size).toBe(ids.length)
        expect(ids).toContain(DRAG_RECT_ID)
        expect(ids).toContain(CLICK_RECT_ID)
    })

    it('同一位置重复点击结果一致', () => {
        const controller = new HitController(createLayout(2000, 1200, 800))
        const target = controller.rects[17]
        const point = inside(target)

        const first = controller.click(point.x, point.y)
        const second = controller.click(point.x, point.y)
        const third = controller.click(point.x, point.y)

        expect(first).toEqual(second)
        expect(second).toEqual(third)
        expect(first.hitId).toBe(target.id)
        expect(first.selectedCount).toBe(1)
    })

    it('点击矩形只选中它，并展示其 id', () => {
        const controller = new HitController(createLayout(1000, 1000, 700))
        const rect = controller.rects.find(item => item.id === 'rect-42')
        expect(rect).toBeDefined()
        const point = inside(rect as { x: number; y: number; width: number; height: number })

        const state = controller.click(point.x, point.y)
        expect(state.selectedCount).toBe(1)
        expect(state.hitId).toBe('rect-42')
        expect(controller.model.selectedId).toBe('rect-42')
    })

    it('先选中 A 再选中 B 时只保留 B', () => {
        const controller = new HitController(createLayout(800, 1000, 700))
        const a = inside(controller.rects[3])
        const b = inside(controller.rects[9])

        expect(controller.click(a.x, a.y).hitId).toBe('rect-3')
        const state = controller.click(b.x, b.y)

        expect(state.selectedCount).toBe(1)
        expect(state.hitId).toBe('rect-9')
        expect(controller.model.selectedId).toBe('rect-9')
    })

    it('点击空白清空选中，命中 id 变为 none', () => {
        const controller = new HitController(createLayout(500, 900, 600))
        const point = inside(controller.rects[5])
        expect(controller.click(point.x, point.y).selectedCount).toBe(1)

        const cleared = controller.click(-10, -10)
        expect(cleared.selectedCount).toBe(0)
        expect(cleared.hitId).toBe('none')
        expect(controller.model.selectedId).toBeNull()
    })

    it('拖拽后按新位置命中，原位置落空', () => {
        const controller = new HitController(createLayout(3, 800, 600))
        const node = controller.rects[0]
        const from = inside(node)
        expect(controller.click(from.x, from.y).hitId).toBe(node.id)

        // 移动到左上角空白区，避免与网格或示例矩形重叠
        const to = { x: 10, y: 400 }
        controller.move(node.id, to.x, to.y)

        expect(hitTest(controller.rects, from.x, from.y)).toBeNull()
        const moved = controller.click(to.x + node.width / 2, to.y + node.height / 2)
        expect(moved.hitId).toBe(node.id)
    })

    it('可拖拽矩形位于最上层，命中不会被网格遮挡', () => {
        const rects = createLayout(10000, 1280, 720)
        const drag = rects.find(item => item.id === DRAG_RECT_ID)
        expect(drag).toBeDefined()
        const point = inside(drag as { x: number; y: number; width: number; height: number })

        expect(rects[rects.length - 1].id).toBe(CLICK_RECT_ID)
        expect(hitTest(rects, point.x, point.y)?.id).toBe(DRAG_RECT_ID)
    })
})
