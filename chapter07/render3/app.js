/**
 * @see [chapter7_example_render3]{@link https://github.com/esangel/WebGL/blob/master/Chap7/render3.js}
 */

import { createProgram, setupWebGL } from "GLHelper";

import vertexShader from "./shader.vert";
import fragmentShader from "./shader.frag";
import blurPassVertexShader from "./blur.vert";
import blurPassFragmentShader from "./blur.frag";

import { texVertices, screenVertices, initialTriangleVertices } from "./data";
import {
  generateSierpinskiTriangle,
  createDoubleBuffer2D,
  createFramebufferObject,
  createVertexBuffer,
  updateVertexBuffer,
  bindVertexBuffer,
  drawImage
} from "./lib";



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
/** @type {HTMLDivElement} */
const statusBar = document.querySelector('#status');

const SCREEN_VERTEX_COUNT = screenVertices.length;


/**
 * 在页面上给出可见的状态/错误提示
 * @param {string} message
 * @param {'info'|'error'} level
 */
function setStatus(message, level = 'info') {
  statusBar.textContent = message;
  statusBar.classList.toggle('error', level === 'error');
}



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
 * @param {{ onError?: (message: string) => void }} hooks
 * @returns {animeFunctions}
 */
function createAnimation(gl, program, effect, { onError } = {}) {
  // —— GPU 资源只创建一次，之后的重置与参数切换全部复用，不随操作次数增长 ——
  const fbo = createFramebufferObject(gl, CANVAS_WIDTH, CANVAS_HEIGHT);
  const doubleBuffer = createDoubleBuffer2D(gl, CANVAS_WIDTH, CANVAS_HEIGHT);
  const fractalBuffer = createVertexBuffer(gl, initialTriangleVertices);
  const screenBuffer = createVertexBuffer(gl, screenVertices);
  const texCoordBuffer = createVertexBuffer(gl, texVertices);

  // 模糊通道的静态采样状态，只需设置一次
  gl.useProgram(effect);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(gl.getUniformLocation(effect, 'texture'), 0);
  const blurDistanceLocation = gl.getUniformLocation(effect, 'blurDistance');

  // —— 动画状态机：播放、单步、重置与参数修改都围绕这份状态协作 ——
  let requestId = 0;          // 当前动画帧句柄，0 表示未在播放
  let failed = false;         // 帧缓冲失败锁存，失败后停止迭代，直到下一次重置
  let fractalVertexCount = 0;
  let blurDistance = 1;       // 当前生效的模糊距离
  let stagedBlurDistance = 1; // 已接纳、将在下一步/下一帧统一生效的模糊距离

  /** 终止播放循环；重复调用是安全的，不会叠加多个循环 */
  function stopLoop() {
    if (requestId !== 0) {
      cancelAnimationFrame(requestId);
      requestId = 0;
    }
  }

  /** 帧缓冲失败：锁存失败状态、终止循环并给出可见提示 */
  function fail(status) {
    failed = true;
    stopLoop();
    const code = `0x${status.toString(16).toUpperCase()}`;
    if (onError) {
      onError(`帧缓冲状态异常（${code}），已停止渲染，请点击“重新绘制”重试`);
    }
    return false;
  }

  /** 把当前生效的模糊距离写入着色器 uniform */
  function applyBlurDistance() {
    gl.useProgram(effect);
    gl.uniform1f(blurDistanceLocation, blurDistance);
  }

  /** 绘制当前分形；返回帧缓冲状态 */
  function drawFractal(options) {
    gl.useProgram(program);
    bindVertexBuffer(gl, fractalBuffer, program, 'vPosition');
    return drawImage(gl, fractalVertexCount, options);
  }

  /** 清空一张纹理的内容；返回帧缓冲状态 */
  function clearTexture(texture) {
    return drawImage(gl, 0, { target: fbo, destination: texture, isClearBeforeDrawing: true });
  }

  /** 渲染进带 mipmap 的纹理后重新生成 mipmap，保证纹理完整 */
  function regenerateMipmap(texture) {
    if (texture === doubleBuffer.mipmappedTexture) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
  }

  /**
   * 推进一帧模糊迭代：read -> write，再把结果显示到屏幕。
   * 返回 false 表示帧缓冲失败，调用方应停止继续迭代。
   */
  function step() {
    // 每一帧开始前统一接纳已暂存的参数，保证同一帧内不会混用新旧参数
    blurDistance = stagedBlurDistance;
    applyBlurDistance();

    gl.useProgram(effect);
    bindVertexBuffer(gl, screenBuffer, effect, 'vPosition');
    bindVertexBuffer(gl, texCoordBuffer, effect, 'vTexCoord');

    const { read, write } = doubleBuffer;

    // 模糊：read -> write
    const status = drawImage(gl, SCREEN_VERTEX_COUNT, {
      target: fbo,
      source: read,
      destination: write,
      isClearBeforeDrawing: true
    });
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      return fail(status);
    }

    // 把结果显示到屏幕
    drawImage(gl, SCREEN_VERTEX_COUNT, { isClearBeforeDrawing: true, source: write });
    regenerateMipmap(write);

    doubleBuffer.swap();
    return true;
  }

  return {
    isPlaying() {
      return requestId !== 0;
    },

    isFailed() {
      return failed;
    },

    /**
     * 接纳新的模糊距离：不打扰当前正在绘制的帧，
     * 在下一步/下一帧开始时统一生效。
     */
    setBlurDistance(distance) {
      stagedBlurDistance = distance;
    },

    /** 单步：暂停状态下只推进一帧；播放中由动画循环推进，手动单步不再重复触发 */
    once() {
      if (requestId !== 0 || failed) {
        return;
      }
      step();
    },

    /** 播放：已处于播放中或失败状态时不重复启动，避免叠加多个动画循环 */
    play() {
      if (requestId !== 0 || failed) {
        return;
      }

      const animeFrame = () => {
        if (!step()) {
          return; // 失败时不再调度后续帧
        }
        requestId = requestAnimationFrame(animeFrame);
      };

      requestId = requestAnimationFrame(animeFrame);
    },

    pause() {
      stopLoop();
    },

    /**
     * 重置：终止正在进行的播放循环，重建分形与双缓冲内容，
     * 之后屏幕上只显示一次新分形，不残留上一轮的模糊结果。
     */
    reset(recursionTime, distance) {
      stopLoop();
      failed = false;

      // 参数在重置时原子生效，不与旧参数混用
      stagedBlurDistance = distance;
      blurDistance = distance;

      // 重建分形几何，复用同一个顶点缓冲区上传新数据
      const sierpinskiTriangleVertices = generateSierpinskiTriangle(...initialTriangleVertices, recursionTime);
      fractalVertexCount = sierpinskiTriangleVertices.length;
      updateVertexBuffer(gl, fractalBuffer, sierpinskiTriangleVertices);

      // 复位双缓冲并清空两张纹理，消除上一轮残留的模糊结果
      doubleBuffer.reset();
      let status = clearTexture(doubleBuffer.read);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        fail(status);
        return;
      }
      status = clearTexture(doubleBuffer.write);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        fail(status);
        return;
      }

      // 将新分形保存在 read 纹理中，为之后的模糊准备原图
      status = drawFractal({
        target: fbo,
        destination: doubleBuffer.read,
        isClearBeforeDrawing: true
      });
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        fail(status);
        return;
      }
      regenerateMipmap(doubleBuffer.read);

      applyBlurDistance();

      // 在屏幕上只画一次新分形
      drawFractal({ isClearBeforeDrawing: true });
    }
  };
}



/** 把输入钳制到 [min, max]；空值、非数字等非法输入回退到 fallback，不破坏当前播放状态 */
const clampToRange = (min, max) => (x, fallback) =>
  Number.isFinite(x) ? Math.min(Math.max(x, min), max) : fallback;

const getSafeRecursionTime = (x, fallback = 0) => Math.round(clampToRange(0, 13)(x, fallback));
const getSafeBlurDistance = (x, fallback = 1) => clampToRange(0, 100)(x, fallback);



/** @description add interactive elements */
const anime = createAnimation(gl, defaultProgram, blurPassProgram, {
  onError(message) {
    setStatus(message, 'error');
  }
});

let recursionTime = getSafeRecursionTime(inputDivideTime.valueAsNumber);
let blurDistance = getSafeBlurDistance(inputBlurDistance.valueAsNumber);
anime.reset(recursionTime, blurDistance);
setStatus('就绪：修改参数后点击“重新绘制”，或点击“应用模糊”/“播放”');


inputDivideTime.onchange = function (event) {
  // 非法输入（空值、非数字、越界）钳制到合法范围并回写，不影响当前播放状态
  recursionTime = getSafeRecursionTime(event.target.valueAsNumber, recursionTime);
  event.target.value = recursionTime;
  setStatus(`分形次数已设为 ${recursionTime}，点击“重新绘制”后生效`);
};

inputBlurDistance.onchange = function (event) {
  blurDistance = getSafeBlurDistance(event.target.valueAsNumber, blurDistance);
  event.target.value = blurDistance;
  // 安全地接纳新参数：正在运行的帧仍使用旧值，下一步/下一帧统一生效
  anime.setBlurDistance(blurDistance);
  setStatus(`模糊距离已设为 ${blurDistance}，将在下一步模糊时生效`);
};


btnReset.onclick = function () {
  anime.reset(recursionTime, blurDistance);
  if (!anime.isFailed()) {
    setStatus(`已重新绘制（分形次数 ${recursionTime}，模糊距离 ${blurDistance}）`);
  }
};

btnOnce.onclick = function () {
  anime.once();
  if (!anime.isFailed() && !anime.isPlaying()) {
    setStatus('已单步推进一帧模糊');
  }
};

btnPlay.onclick = function () {
  if (anime.isPlaying()) {
    anime.pause();
    setStatus('已暂停');
  } else {
    anime.play();
    if (!anime.isFailed()) {
      setStatus('播放中');
    }
  }
};
