/**
 * render3 的参数归一化与“待应用 / 已应用”状态管理。
 *
 * 本模块不依赖任何 WebGL / DOM API，可以直接在 Node 中离线测试。
 * app.js 只负责把本模块的纯逻辑接到页面控件与动画上。
 *
 * 语义约定：
 * - 输入框的任何修改只更新“待应用参数”（pending），不影响正在播放的画面；
 * - 点击“重新绘制（重置）”时，才把待应用参数一次性拷贝为“已应用参数”（applied），
 *   并重新生成底图；播放 / 单步始终读取已应用参数。
 */

/** 递归次数不合法时的兜底值 */
export const DEFAULT_RECURSION_TIME = 1;

/** 模糊距离不合法时的兜底值 */
export const DEFAULT_BLUR_DISTANCE = 1;

/** 递归次数允许的闭区间范围 */
export const RECURSION_TIME_MIN = 0;
export const RECURSION_TIME_MAX = 13;

/**
 * 把输入转换成数字。
 * 数字原样返回；字符串先去除首尾空白，空白字符串视为“未填写”（返回 NaN），
 * 其余情况交给 Number() 转换（Number('') === 0 的隐式行为在这里被排除）。
 * @param {*} value
 * @returns {number}
 */
function toFiniteCandidate(value) {
  if (typeof value === 'string' && value.trim() === '') {
    return NaN;
  }
  return typeof value === 'number' ? value : Number(value);
}

/**
 * 把任意输入归一化为合法的递归次数：
 * - 必须是有限数字（字符串会先尝试转成数字）；
 * - 必须是整数；
 * - 必须落在 [0, 13] 闭区间内；
 * - 越界、非整数或非数字一律回退为 1。
 * @param {*} value
 * @returns {number}
 */
export function normalizeRecursionTime(value) {
  const n = toFiniteCandidate(value);

  if (!Number.isFinite(n)) {
    return DEFAULT_RECURSION_TIME;
  }
  if (!Number.isInteger(n)) {
    return DEFAULT_RECURSION_TIME;
  }
  if (n < RECURSION_TIME_MIN || n > RECURSION_TIME_MAX) {
    return DEFAULT_RECURSION_TIME;
  }
  return n;
}

/**
 * 把任意输入归一化为合法的模糊距离：
 * - 允许任意有限数（含 0、负数、小数，字符串会先尝试转成数字）；
 * - 非数字或无穷值回退为 1。
 * @param {*} value
 * @returns {number}
 */
export function normalizeBlurDistance(value) {
  const n = toFiniteCandidate(value);
  return Number.isFinite(n) ? n : DEFAULT_BLUR_DISTANCE;
}

/**
 * 创建参数状态容器。
 *
 * @typedef {Object} ParameterStore
 * @property {() => {recursionTime: number, blurDistance: number}} getPending 读取待应用参数（返回副本）
 * @property {() => {recursionTime: number, blurDistance: number}} getApplied 读取已应用参数（返回副本）
 * @property {(patch: {recursionTime?: *, blurDistance?: *}) => {recursionTime: number, blurDistance: number}}
 *   setPending 只更新待应用参数，输入会先经过归一化，返回归一化后的待应用参数副本
 * @property {() => {recursionTime: number, blurDistance: number}}
 *   applyPending 把待应用参数一次性应用为已应用参数（由“重置”按钮触发），返回新的已应用参数副本
 */

/**
 * @param {{recursionTime: *, blurDistance: *}} initialParameters 初始参数，
 *   初始化时待应用值与已应用值保持一致
 * @returns {ParameterStore}
 */
export function createParameterStore(initialParameters = {}) {
  let pending = {
    recursionTime: normalizeRecursionTime(initialParameters.recursionTime),
    blurDistance: normalizeBlurDistance(initialParameters.blurDistance),
  };
  let applied = { ...pending };

  const copy = (state) => ({ ...state });

  return {
    getPending() {
      return copy(pending);
    },

    getApplied() {
      return copy(applied);
    },

    setPending(patch = {}) {
      if (Object.prototype.hasOwnProperty.call(patch, 'recursionTime')) {
        pending = {
          ...pending,
          recursionTime: normalizeRecursionTime(patch.recursionTime),
        };
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'blurDistance')) {
        pending = {
          ...pending,
          blurDistance: normalizeBlurDistance(patch.blurDistance),
        };
      }
      return copy(pending);
    },

    applyPending() {
      applied = { ...pending };
      return copy(applied);
    },
  };
}
