/** 统计最近 N 帧的平均帧率。 */
export class FpsMeter {
    private frames: number[] = []

    constructor(private readonly maxFrames = 60) {}

    /** 记录一帧的时间戳（毫秒）。 */
    public record(time: number): void {
        this.frames.push(time)
        if (this.frames.length > this.maxFrames) this.frames.shift()
    }

    /** 最近 maxFrames 帧内的平均帧率；帧数不足时返回 0，避免给出误导性数值。 */
    public get average(): number {
        const { frames } = this
        if (frames.length < 2) return 0
        const elapsed = frames[frames.length - 1] - frames[0]
        return elapsed > 0 ? ((frames.length - 1) * 1000) / elapsed : 0
    }

    public get samples(): number {
        return this.frames.length
    }

    public reset(): void {
        this.frames = []
    }
}

/** 把帧率格式化为一位小数，非有限值显示为 0.0 */
export function formatFps(fps: number): string {
    if (!Number.isFinite(fps) || fps < 0) return '0.0'
    return fps.toFixed(1)
}
