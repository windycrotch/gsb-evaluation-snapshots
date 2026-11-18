export interface SelectionState {
    /** 当前选中数量（单选模型下为 0 或 1） */
    selectedCount: number
    /** 最近一次点击命中的矩形 id，未命中为 'none' */
    hitId: string
}

type SelectionListener = (state: SelectionState) => void

/**
 * 页面指标的可测试内核：把交互与渲染解耦，便于在 jsdom 中驱动。
 * 所有状态变化都通过方法收敛，并通知订阅者刷新 UI。
 */
export class SelectionModel {
    private selected: string | null = null
    private hit = 'none'
    private listeners: SelectionListener[] = []

    public get state(): SelectionState {
        return { selectedCount: this.selected ? 1 : 0, hitId: this.hit }
    }

    public get selectedId(): string | null {
        return this.selected
    }

    /** 订阅状态变化，返回取消订阅函数 */
    public onChange(listener: SelectionListener): () => void {
        this.listeners.push(listener)
        listener(this.state)
        return () => {
            this.listeners = this.listeners.filter(item => item !== listener)
        }
    }

    /** 命中某个矩形：只选中它，并记录命中 id */
    public select(id: string): SelectionState {
        this.selected = id
        this.hit = id
        return this.notify()
    }

    /** 点击空白：清空选中，命中 id 记为 none */
    public clear(): SelectionState {
        this.selected = null
        this.hit = 'none'
        return this.notify()
    }

    /**
     * 统一的点击入口：传入命中的 id（或 null），内部决定选中还是清空。
     * 同一位置重复点击会得到相同结果。
     */
    public click(hitId: string | null): SelectionState {
        return hitId ? this.select(hitId) : this.clear()
    }

    private notify(): SelectionState {
        const state = this.state
        for (const listener of this.listeners) listener(state)
        return state
    }
}
