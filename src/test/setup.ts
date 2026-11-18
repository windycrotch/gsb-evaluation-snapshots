/**
 * jsdom 环境补丁：LeaferJS 面向浏览器，导入时会访问 CanvasRenderingContext2D、
 * Path2D 与 PointerEvent / DragEvent 等浏览器全局对象，而 jsdom 并不提供它们。
 *
 * 这里只补最小可用的桩：
 * - CanvasRenderingContext2D / Path2D 用于模块加载期的原型补丁；
 * - canvas.getContext('2d') 返回一个记录型假上下文，满足布局与渲染调用；
 * - PointerEvent / DragEvent 用于 Platform.origin 绑定。
 */

function createFakeContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    // 画布方法只需要可调用、不抛错，返回值无意义
    const noop = (...args: unknown[]): void => {
        void args.length
    }
    const state: Record<string, unknown> = {
        canvas,
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'low',
        lineWidth: 1,
        lineCap: 'butt',
        lineJoin: 'miter',
        miterLimit: 10,
        lineDashOffset: 0,
        fillStyle: '#000',
        strokeStyle: '#000',
        shadowColor: 'rgba(0,0,0,0)',
        shadowBlur: 0,
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        filter: 'none',
        font: '10px sans-serif',
        textAlign: 'start',
        textBaseline: 'alphabetic'
    }

    const context = new Proxy(state, {
        get(target, key: string) {
            if (key in target) return target[key]
            switch (key) {
                case 'getImageData':
                    return (_x: number, _y: number, width = 1, height = 1) => ({
                        width,
                        height,
                        data: new Uint8ClampedArray(Math.max(1, width * height * 4))
                    })
                case 'measureText':
                    return () => ({ width: 0 })
                case 'getLineDash':
                    return (): number[] => []
                case 'getTransform':
                    return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
                case 'isPointInPath':
                case 'isPointInStroke':
                    return () => false
                case 'createLinearGradient':
                case 'createRadialGradient':
                case 'createConicGradient':
                case 'createPattern':
                    return () => ({ addColorStop: noop })
                case 'createImageData':
                    return (width = 1, height = 1) => ({ width, height, data: new Uint8ClampedArray(Math.max(1, width * height * 4)) })
                default:
                    return noop
            }
        },
        set(target, key: string, value) {
            target[key] = value
            return true
        }
    })

    return context as unknown as CanvasRenderingContext2D
}

if (typeof HTMLCanvasElement !== 'undefined') {
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
        return createFakeContext(this) as never
    } as typeof HTMLCanvasElement.prototype.getContext
}

const globalObject = globalThis as unknown as Record<string, unknown>

if (!globalObject.CanvasRenderingContext2D) globalObject.CanvasRenderingContext2D = class {}
if (!globalObject.Path2D) globalObject.Path2D = class {}
if (!globalObject.PointerEvent) globalObject.PointerEvent = class extends (globalObject.MouseEvent as typeof MouseEvent) {}
if (!globalObject.DragEvent) globalObject.DragEvent = class extends (globalObject.MouseEvent as typeof MouseEvent) {}

if (typeof window !== 'undefined' && typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16)) as never
    window.cancelAnimationFrame = ((handle: number) => clearTimeout(handle)) as never
}
