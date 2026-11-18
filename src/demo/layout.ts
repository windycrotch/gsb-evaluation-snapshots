export interface RectSpec {
    /** 稳定且唯一的 id */
    id: string
    x: number
    y: number
    width: number
    height: number
    color: string
    /** 是否可拖拽 */
    draggable?: boolean
    /** 是否为示例矩形（配色上做区分，且绘制在最上层） */
    featured?: boolean
}

export const DRAG_RECT_ID = 'rect-drag'
export const CLICK_RECT_ID = 'rect-click'

const palette = [
    '#2f6fed',
    '#32cd79',
    '#f2a541',
    '#e0575b',
    '#9b5de5',
    '#00bbf9',
    '#f15bb5',
    '#8ac926',
    '#ff924c',
    '#5e60ce',
    '#20c997',
    '#ef476f'
]

const GRID_FILL = '#4a86ff'
const DRAG_FILL = '#ff2d55'
const CLICK_FILL = '#ffd400'

/** 单元格最大边长，避免矩形数量很少时铺成巨大色块 */
const MAX_CELL = 120
/** 示例矩形的尺寸范围与边距 */
const MIN_FEATURED_SIZE = 52
const MAX_FEATURED_SIZE = 112
const FEATURED_PADDING = 24
const FEATURED_GAP = 16

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
}

/** 两个固定示例矩形：一个可拖拽，一个用于点击选中。它们绘制在最上层，且网格会避开这块区域。 */
function featuredRects(width: number, height: number): RectSpec[] {
    const size = clamp(Math.min(width, height) * 0.12, MIN_FEATURED_SIZE, MAX_FEATURED_SIZE)
    const x = Math.min(FEATURED_PADDING, Math.max(0, width - size))
    const y = Math.min(FEATURED_PADDING, Math.max(0, height - size))
    const x2 = Math.min(x + size + FEATURED_GAP, Math.max(0, width - size))
    return [
        {
            id: DRAG_RECT_ID,
            x,
            y,
            width: size,
            height: size,
            color: DRAG_FILL,
            draggable: true,
            featured: true
        },
        {
            id: CLICK_RECT_ID,
            x: x2,
            y,
            width: size,
            height: size,
            color: CLICK_FILL,
            featured: true
        }
    ]
}

/**
 * 以确定性的网格铺开 count 个矩形（网格居中，并避开顶部示例矩形所在的区域），
 * 再在最上层放置两个固定示例矩形。总数量恒等于 count（count < 2 时只保留示例矩形）。
 * 同一 count / 视口尺寸下结果完全一致，因此 id 与坐标都是稳定的。
 * 返回顺序即绘制顺序，越靠后越在上层。
 */
export function createLayout(count: number, width: number, height: number): RectSpec[] {
    const total = Math.max(1, Math.floor(count))
    const w = width > 0 ? width : 800
    const h = height > 0 ? height : 600

    const rects: RectSpec[] = []
    const featured = featuredRects(w, h)

    const gridCount = Math.max(0, total - 2)
    if (gridCount > 0) {
        // 为示例矩形预留顶部区域，避免网格节点遮挡它们
        const reservedTop = Math.min(h * 0.4, Math.max(featured[0].y + featured[0].height, featured[1].y + featured[1].height) + FEATURED_PADDING)
        const gridWidth = w
        const gridHeight = Math.max(1, h - reservedTop)

        const aspect = gridWidth / gridHeight
        const cols = Math.max(1, Math.round(Math.sqrt(gridCount * aspect)))
        const rows = Math.max(1, Math.ceil(gridCount / cols))

        const cell = Math.max(1, Math.min(gridWidth / cols, gridHeight / rows, MAX_CELL))
        const size = Math.max(1, cell * 0.82)

        const offsetX = (gridWidth - cols * cell) / 2 + (cell - size) / 2
        const offsetY = reservedTop + (gridHeight - rows * cell) / 2 + (cell - size) / 2

        for (let i = 0; i < gridCount; i++) {
            const col = i % cols
            const row = Math.floor(i / cols)
            rects.push({
                id: `rect-${i}`,
                x: offsetX + col * cell,
                y: offsetY + row * cell,
                width: size,
                height: size,
                color: gridCount === 1 ? GRID_FILL : palette[i % palette.length]
            })
        }
    }

    if (total === 1) return [featured[0]]
    rects.push(featured[0], featured[1])

    return rects
}

/**
 * 命中判定：按绘制顺序从上层到下层查找覆盖该点的矩形，未命中返回 null。
 * 纯几何函数，输入相同则输出恒定。
 */
export function hitTest(rects: RectSpec[], x: number, y: number): RectSpec | null {
    for (let i = rects.length - 1; i >= 0; i--) {
        const rect = rects[i]
        if (
            x >= rect.x &&
            x <= rect.x + rect.width &&
            y >= rect.y &&
            y <= rect.y + rect.height
        ) {
            return rect
        }
    }
    return null
}

/**
 * 把某个矩形移动到新的左上角坐标（拖拽时与引擎节点同步）。
 * 找不到 id 时返回 false。
 */
export function moveRectTo(rects: RectSpec[], id: string, x: number, y: number): boolean {
    for (let i = 0; i < rects.length; i++) {
        if (rects[i].id === id) {
            rects[i].x = x
            rects[i].y = y
            return true
        }
    }
    return false
}
