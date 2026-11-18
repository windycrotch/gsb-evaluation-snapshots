export const DEFAULT_COUNT = 20000
export const MAX_COUNT = 100000

export interface CountResult {
    /** 最终使用的矩形数量 */
    count: number
    /** 是否发生了回退 */
    fallback: boolean
    /** 回退时展示给用户的提示文字 */
    message?: string
}

/**
 * 解析 URL 中的 count 参数。
 * - 未提供该参数时静默使用默认值；
 * - 提供了但不是正整数（空串、0、负数、小数、字母等）时回退到默认值并给出提示；
 * - 超过上限时回退到默认值并给出提示。
 */
export function parseCount(raw: string | null | undefined): CountResult {
    if (raw === null || raw === undefined) {
        return { count: DEFAULT_COUNT, fallback: false }
    }

    const value = raw.trim()
    if (!/^[0-9]+$/.test(value)) {
        return {
            count: DEFAULT_COUNT,
            fallback: true,
            message: `count 参数 “${raw}” 不是正整数，已回退到默认值 ${DEFAULT_COUNT}`
        }
    }

    const count = Number(value)
    if (!Number.isSafeInteger(count) || count <= 0) {
        return {
            count: DEFAULT_COUNT,
            fallback: true,
            message: `count 参数 “${raw}” 不是正整数，已回退到默认值 ${DEFAULT_COUNT}`
        }
    }

    if (count > MAX_COUNT) {
        return {
            count: DEFAULT_COUNT,
            fallback: true,
            message: `count 参数 ${count} 超过上限 ${MAX_COUNT}，已回退到默认值 ${DEFAULT_COUNT}`
        }
    }

    return { count, fallback: false }
}
