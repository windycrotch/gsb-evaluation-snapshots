/**
 * @see [chapter7_example_render3]{@link https://github.com/esangel/WebGL/blob/master/Chap7/render3.js}
 */

import { createProgram, setupWebGL } from "GLHelper";

import vertexShader from "./shader.vert";
import fragmentShader from "./shader.frag";
import blurPassVertexShader from "./blur.vert";
import blurPassFragmentShader from "./blur.frag";

import { texVertices, screenVertices, initialTriangleVertices } from "./data";
import { generateSierpinskiTriangle, createDoubleBuffer2D, createFramebufferObject, drawImage, setProgramAttributeArray } from "./lib";
import { createParameterStore } from "./params.mjs";



/** @type {HTMLCanvasElement} */
const canvas = document.querySelector('#gl-canvas');
const CANVAS_WIDTH = canvas.width;
const CANVAS_HEIGHT = canvas.height;

const gl = setupWebGL(canvas);
const defaultProgram = createProgram(gl, vertexShader, fragmentShader);
const blurPassProgram = createProgram(gl, blurPassVertexShader, blurPassFragmentShader);

// 设置屏幕坐标系数 x, y, w, h（用于视口转换，将标准化设备坐标转换成屏幕坐标）
// 可以将传入的顶点 x0, y0 转换成 x1, y1
// 其中：
//     x1 = x + (x0 + 1) * w / 2
//     y1 = y + (y0 + 1) * h / 2
gl.viewport(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
gl.clearColor(1.0, 1.0, 1.0, 1.0);



// 一些设置项
/** @type {HTMLInputElement} */
const inputDivideTime = document.querySelector('#divide');
/** @type {HTMLInputElement} */
const inputBlurDistance = document.querySelector('#distance');
/** @type {HTMLButtonElement} */
const btnOnce = document.querySelector('#once');
/** @type {HTMLButtonElement} */
const btnPlay = document.querySelector('#play');
/** @type {HTMLButtonElement} */
const btnReset = document.querySelector('#reset');
/** @type {HTMLElement} */
const appliedRecursionTimeOutput = document.querySelector('#applied-divide');
/** @type {HTMLElement} */
const appliedBlurDistanceOutput = document.querySelector('#applied-distance');



/**
 * @typedef animeFunctions
 * @property {() => void} once
 * @property {() => void} play
 * @property {() => void} pause
 * @property {(recursionTime: number, blurDistance: number) => void} reset
 * @property {() => boolean} isPlaying
 * @property {(blurDistance: number) => void} setBlurDistance
 *
 * @param {WebGLRenderingContext} gl
 * @param {WebGLProgram} program
 * @param {WebGLProgram} effect
 * @returns {animeFunctions}
 */
function createAnimation(gl, program, effect) {
  let requestId = 0;

  const fbo = createFramebufferObject(gl, CANVAS_WIDTH, CANVAS_HEIGHT);
  const doubleBuffer = createDoubleBuffer2D(gl, CANVAS_WIDTH, CANVAS_HEIGHT);

  return {
    isPlaying() {
      return !!requestId;
    },

    setBlurDistance(blurDistance) {
      gl.useProgram(effect);
      setProgramAttributeArray(gl, effect, 'vPosition', screenVertices);
      setProgramAttributeArray(gl, effect, 'vTexCoord', texVertices);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(gl.getUniformLocation(effect, 'texture'), 0);
      gl.uniform1f(gl.getUniformLocation(effect, 'blurDistance'), blurDistance);
    },

    once() {
      const { value: { front, back } } = doubleBuffer.next();

      drawImage(gl, screenVertices, {
        target: fbo,
        source: back,
        destination: front
      });

      drawImage(gl, screenVertices, {
        isClearBeforeDrawing: true,
        source: front
      });
    },

    play() {
      if (this.isPlaying()) {
        return;
      }

      const animeFrame = () => {
        this.once();
        requestId = requestAnimationFrame(animeFrame)
      }

      animeFrame();
    },

    pause() {
      this.isPlaying() && cancelAnimationFrame(requestId);
      requestId = 0;
    },

    reset(recursionTime, blurDistance) {
      // 重置（包括播放中触发的重置）先停止动画，再以新参数重新生成底图
      this.pause();

      let sierpinskiTriangleVertices = generateSierpinskiTriangle(...initialTriangleVertices, recursionTime);

      gl.useProgram(program);
      setProgramAttributeArray(gl, program, 'vPosition', sierpinskiTriangleVertices);

      // 在屏幕上先画出原图
      drawImage(gl, sierpinskiTriangleVertices, {
        isClearBeforeDrawing: true
      });

      // 同时将原图保存在一个纹理图像中，为之后的模糊准备原图
      let { value: { front } } = doubleBuffer.next();
      drawImage(gl, sierpinskiTriangleVertices, {
        isClearBeforeDrawing: true,
        target: fbo,
        destination: front
      });

      // 模糊距离属于“已应用参数”的一部分，只在重置时写入着色器
      this.setBlurDistance(blurDistance);
    }
  }
}


/**
 * 参数状态：输入框只改“待应用参数”，点击重置时才一次性应用为“已应用参数”。
 * 归一化规则（0~13 整数，越界/非数字回退 1；模糊距离允许任意有限数，非数字回退 1）
 * 全部收敛在 params.mjs 中，可在 Node 下离线测试。
 */
const parameterStore = createParameterStore({
  recursionTime: inputDivideTime.valueAsNumber,
  blurDistance: inputBlurDistance.valueAsNumber,
});

/** @description add interactive elements */
const anime = createAnimation(gl, defaultProgram, blurPassProgram);

/**
 * 把已应用参数渲染到页面，便于确认当前画面实际对应的参数。
 * @param {{recursionTime: number, blurDistance: number}} applied
 */
function renderAppliedParameters(applied) {
  appliedRecursionTimeOutput.textContent = String(applied.recursionTime);
  appliedBlurDistanceOutput.textContent = String(applied.blurDistance);
}

/**
 * 重置：把待应用参数一次性应用到画面，并更新页面与控制台中的已应用参数。
 * 播放中调用时动画会先停止，重新生成底图后可再次点播放继续。
 */
function resetWithAppliedParameters() {
  const applied = parameterStore.applyPending();

  anime.reset(applied.recursionTime, applied.blurDistance);
  renderAppliedParameters(applied);

  // 在控制台也保留一份可观察的已应用参数
  console.log('[render3] applied parameters:', { ...applied });
}

// 页面初始化即应用一次参数，生成初始底图
resetWithAppliedParameters();


/**
 * 修改输入框只更新待应用值（并把归一化后的值回写到输入框），
 * 不会触碰正在播放的动画。
 */
inputDivideTime.onchange = function (event) {
  const pending = parameterStore.setPending({
    recursionTime: event.target.valueAsNumber,
  });
  event.target.value = pending.recursionTime;
}

inputBlurDistance.onchange = function (event) {
  const pending = parameterStore.setPending({
    blurDistance: event.target.valueAsNumber,
  });
  event.target.value = pending.blurDistance;
}


btnReset.onclick = function () {
  resetWithAppliedParameters();
}

btnOnce.onclick = function () {
  // 单步始终使用已应用参数（模糊距离在重置时已写入着色器 uniform）
  anime.once();
}

btnPlay.onclick = function () {
  anime.isPlaying() ? anime.pause() : anime.play();
}

// 暴露到全局，方便在浏览器控制台检查待应用 / 已应用参数
window.render3Params = parameterStore;
