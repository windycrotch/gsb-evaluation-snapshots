import { hitTest, moveRectTo, RectSpec } from './layout'
import { SelectionModel, SelectionState } from './selection'

/**
 * 点击交互的纯逻辑内核：不依赖 Canvas，可直接在 Node / jsdom 中测试。
 * 场景层（scene.ts）把引擎事件转发到这里，保证自动化测试与真实行为一致。
 */
export class HitController {
    constructor(
        public rects: RectSpec[],
        public readonly model: SelectionModel = new SelectionModel()
    ) {}

    public get state(): SelectionState {
        return this.model.state
    }

    /** 在场景坐标 (x, y) 点击一次，返回最新状态 */
    public click(x: number, y: number): SelectionState {
        const hit = hitTest(this.rects, x, y)
        return this.model.click(hit ? hit.id : null)
    }

    /** 直接以已知的命中 id 点击（供引擎事件转发使用），null 代表空白 */
    public clickId(id: string | null): SelectionState {
        return this.model.click(id)
    }

    /** 拖拽结束后同步矩形位置 */
    public move(id: string, x: number, y: number): boolean {
        return moveRectTo(this.rects, id, x, y)
    }
}
