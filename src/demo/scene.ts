import { Leafer, Rect } from 'leafer-ui'

import { createLayout, DRAG_RECT_ID, moveRectTo, RectSpec } from './layout'
import { HitController } from './controller'
import { SelectionState } from './selection'

export interface SceneOptions {
    count: number
}

export interface Scene {
    leafer: Leafer
    controller: HitController
    /** 当前矩形数据（坐标会随拖拽同步更新） */
    rects: RectSpec[]
    /** 当前布局使用的尺寸（容器尚未就绪时为兜底尺寸） */
    layoutSize: { width: number; height: number }
    /** 在场景坐标系中执行一次点击并更新选中状态 */
    clickAt(x: number, y: number): SelectionState
    /** 视口尺寸变化后重新铺开矩形 */
    relayout(): void
    destroy(): void
}

export const SELECTED_STROKE = '#00e5ff'
export const SELECTED_STROKE_WIDTH = 3

/** 容器尺寸尚未就绪（0 / 1px）时使用的兜底尺寸 */
const FALLBACK_WIDTH = 960
const FALLBACK_HEIGHT = 640

/**
 * 取当前可用于布局的画布尺寸。
 * Leafer 在浏览器中通过 ResizeObserver 跟随容器尺寸；
 * 若尺寸异常（如首帧容器尚未布局）则退回视口尺寸，避免所有矩形挤成一团。
 */
export function resolveStageSize(leafer: { width?: number; height?: number }): { width: number; height: number } {
    const width = Number(leafer.width) || 0
    const height = Number(leafer.height) || 0
    if (width > 1 && height > 1) return { width, height }

    const hasWindow = typeof window !== 'undefined'
    return {
        width: hasWindow && window.innerWidth > 1 ? window.innerWidth : FALLBACK_WIDTH,
        height: hasWindow && window.innerHeight > 1 ? window.innerHeight : FALLBACK_HEIGHT
    }
}

/**
 * 构建可交互的大规模矩形场景：
 * - 其中一个矩形可拖拽；
 * - 点击命中矩形则只选中它，点击空白则清空选中；
 * - 所有矩形 id 稳定唯一。
 */
export function createScene(view: HTMLElement, options: SceneOptions): Scene {
    const { count } = options

    // hitRadius = 0：点击必须落在矩形内才算命中，避免“点到空白却选中了近邻矩形”
    const leafer = new Leafer({ view, fill: '#ffffff', hittable: true, pointer: { hitRadius: 0 } })

    const initialSize = resolveStageSize(leafer)
    const controller = new HitController(createLayout(count, initialSize.width, initialSize.height))

    let nodes: Rect[] = []
    let dragNode: Rect | null = null
    let selectedNode: Rect | null = null

    function createNode(spec: RectSpec): Rect {
        return new Rect({
            id: spec.id,
            x: spec.x,
            y: spec.y,
            width: spec.width,
            height: spec.height,
            fill: spec.color,
            // 全部为轴对齐矩形，用包围盒命中即可：避免每次拾取都走命中画布，
            // 在 2 万级图形下显著降低 hover / 拖拽的拾取开销
            hitBox: true,
            draggable: spec.draggable || undefined,
            cursor: spec.draggable ? 'grab' : undefined
        })
    }

    /** 选中样式是展示层职责，数据层与指标不受影响 */
    function paint(state: SelectionState): void {
        if (selectedNode) {
            selectedNode.stroke = undefined
            selectedNode.strokeWidth = 0
            selectedNode = null
        }

        if (state.selectedCount > 0 && state.hitId !== 'none') {
            const index = controller.rects.findIndex(item => item.id === state.hitId)
            const node = nodes[index]
            if (node) {
                node.stroke = SELECTED_STROKE
                node.strokeWidth = SELECTED_STROKE_WIDTH
                selectedNode = node
            }
        }
    }

    // 所有状态变化（含引擎事件）都会经过 model，这里统一刷新选中样式
    controller.model.onChange(paint)

    function build(): void {
        const size = resolveStageSize(leafer)
        controller.rects = createLayout(count, size.width, size.height)
        nodes = controller.rects.map(createNode)
        dragNode = nodes.find(node => node.id === DRAG_RECT_ID) || null
        // 一次性批量添加，避免逐节点触发多次重排
        leafer.add(nodes)
    }

    function clickAt(x: number, y: number): SelectionState {
        return controller.click(x, y)
    }

    function relayout(): void {
        const size = resolveStageSize(leafer)
        controller.rects = createLayout(count, size.width, size.height)
        // 复用节点，避免重建上万个对象
        controller.rects.forEach((spec, index) => {
            const node = nodes[index]
            if (!node) return
            node.set({ x: spec.x, y: spec.y, width: spec.width, height: spec.height })
        })
        // 节点尺寸变化可能影响高亮描边，重新绘制一次当前状态
        paint(controller.state)
    }

    function syncDraggedRect(): void {
        // dragNode 在构建时缓存，拖拽帧内不再做 O(n) 查找
        if (dragNode) moveRectTo(controller.rects, DRAG_RECT_ID, dragNode.x as number, dragNode.y as number)
    }

    function onTap(event: { target: unknown; x?: number; y?: number }): void {
        // 优先使用引擎判定出的 target（id 来自同一场景树）；
        // 兜底：引擎命中不到图形时 target 为 leafer 自身，视为点击空白。
        const target = event.target as Rect
        const isShape = !!target && target !== (leafer as unknown)

        if (isShape) {
            controller.clickId(target.id as string)
            return
        }

        // 点击空白：用点击坐标复核一次几何命中，避免因容器缩放出偏差
        if (typeof event.x === 'number' && typeof event.y === 'number') controller.click(event.x, event.y)
        else controller.clickId(null)
    }

    function onDragStart(): void {
        if (dragNode) dragNode.cursor = 'grabbing'
        syncDraggedRect()
    }

    function onDrag(): void {
        syncDraggedRect()
    }

    function onDragEnd(): void {
        if (dragNode) dragNode.cursor = 'grab'
        syncDraggedRect()
    }

    build()

    leafer.on('tap', onTap)
    leafer.on('drag.start', onDragStart)
    leafer.on('drag', onDrag)
    leafer.on('drag.end', onDragEnd)

    return {
        leafer,
        controller,
        get rects() {
            return controller.rects
        },
        get layoutSize() {
            return resolveStageSize(leafer)
        },
        clickAt,
        relayout,
        destroy() {
            leafer.off('tap', onTap)
            leafer.off('drag.start', onDragStart)
            leafer.off('drag', onDrag)
            leafer.off('drag.end', onDragEnd)
            leafer.destroy()
        }
    }
}

export type { RectSpec }
