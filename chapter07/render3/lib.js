import { pointsToBuffer } from "GLHelper";
import { vec2 } from "gl-matrix";


/**
 * @param {vec2} A
 * @param {vec2} B
 * @param {vec2} C
 * @param {number} recursionTime
 * @returns {vec2[]}
 */
export function generateSierpinskiTriangle(A, B, C, recursionTime) {
  return divideTriangle(A, B, C, recursionTime, []);
}

/**
 * @param {vec2} A
 * @param {vec2} B
 * @param {vec2} C
 * @param {number} count
 * @param {vec2[]} points
 * @returns {vec2}
 */
function divideTriangle(A, B, C, count, points) {
  if (count === 0) {
    points.push(A, B, C);
  } else {
    const midOfAB = vec2.lerp(A, B, 0.5);
    const midOfAC = vec2.lerp(A, C, 0.5);
    const midOfBC = vec2.lerp(B, C, 0.5);

    count--;

    divideTriangle(A, midOfAB, midOfAC, count, points);
    divideTriangle(C, midOfAC, midOfBC, count, points);
    divideTriangle(B, midOfBC, midOfAB, count, points);
  }

  return points
}




/**
 * 创建顶点缓冲区并上传初始数据。
 * 缓冲区创建后应通过 updateVertexBuffer 复用，避免每次重绘都新建 GPU 缓冲区。
 * @param {WebGLRenderingContext} gl
 * @param {vec2[]} vertices
 * @returns {WebGLBuffer}
 */
export function createVertexBuffer(gl, vertices) {
  const buffer = gl.createBuffer();
  updateVertexBuffer(gl, buffer, vertices);
  return buffer;
}


/**
 * 复用已有的顶点缓冲区，重新上传顶点数据（不新建缓冲区，避免 GPU 资源随操作次数无限增长）
 * @param {WebGLRenderingContext} gl
 * @param {WebGLBuffer} buffer
 * @param {vec2[]} vertices
 */
export function updateVertexBuffer(gl, buffer, vertices) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, pointsToBuffer(vertices), gl.STATIC_DRAW);
}


/**
 * 将已有的顶点缓冲区绑定到着色器的 attribute 上（只更新指针状态，不重复上传数据）
 * @param {WebGLRenderingContext} gl
 * @param {WebGLBuffer} buffer
 * @param {WebGLProgram} program
 * @param {string} attribute
 */
export function bindVertexBuffer(gl, buffer, program, attribute) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

  // 让应用获取 attribute 在 WebGLProgram 中的位置
  const attributeLocation = gl.getAttribLocation(program, attribute);

  // 将缓冲区对象分配给对应的 attribute 变量，这里都是二维的点
  gl.vertexAttribPointer(attributeLocation, 2, gl.FLOAT, false, 0, 0);

  // 开启 attribute 变量
  gl.enableVertexAttribArray(attributeLocation);
}




/**
 * 绘制一次；若指定了 destination 纹理，绘制前会检查帧缓冲完整性。
 * 帧缓冲不完整时不继续绘制，直接把状态码返回给调用方处理。
 * @param {WebGLRenderingContext} gl
 * @param {number} vertexCount 顶点个数
 * @param {{
 *   isClearBeforeDrawing?: boolean
 *   target?: WebGLFramebuffer
 *   source?: WebGLTexture
 *   destination?: WebGLTexture
 * }} options
 * @returns {number} 帧缓冲状态，gl.FRAMEBUFFER_COMPLETE 表示正常
 */
export function drawImage(gl, vertexCount, { isClearBeforeDrawing, target, source, destination } = {}) {

  // 将当前屏幕渲染的上下文环境切到我们创建的帧缓冲区上
  // 这样之后绘制出的图像会被保存在当前绑定的帧缓冲区中
  // 用于离屏渲染（Off-screen rendering）， 也被称作后处理（Post-processing）
  gl.bindFramebuffer(gl.FRAMEBUFFER, target || null);

  if (source) {
    gl.bindTexture(gl.TEXTURE_2D, source);
  }

  if (destination) {

    // 防止反馈环（Feedback loop）：目标纹理不能同时被当前程序采样。
    // 若本次绘制没有显式指定采样源，先把采样单元上残留的纹理解绑。
    if (!source) {
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    // 将纹理作为颜色附件绑定到当前的帧缓冲区上
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, destination, 0);

    // 检查状态是否为完成；失败时不继续绘制，把状态交给调用方
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      return status;
    }
  }

  isClearBeforeDrawing && gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, vertexCount);

  return gl.FRAMEBUFFER_COMPLETE;
}



/**
 * @param {WebGLRenderingContext} gl
 * @param {number} width
 * @param {number} height
 * @returns {WebGLFramebuffer}
 */
export function createFramebufferObject(gl, width, height) {
  // 分配一段 GPU 内存做为新的帧缓冲对象（FBO, Framebuffer Object）
  const fbo = gl.createFramebuffer();

  fbo.width = width;
  fbo.height = height;

  return fbo;
}



/**
 * 双缓冲纹理对：read 为当前采样源，write 为当前渲染目标。
 * 两张纹理只创建一次，之后通过 swap/reset 复用，不随操作次数增长。
 * @param {WebGLRenderingContext} gl
 * @param {number} width
 * @param {number} height
 * @returns {{
 *   textures: WebGLTexture[],
 *   mipmappedTexture: WebGLTexture,
 *   read: WebGLTexture,
 *   write: WebGLTexture,
 *   swap: () => void,
 *   reset: () => void,
 * }}
 */
export function createDoubleBuffer2D(gl, width, height) {
  const textures = [
    createTexture2D(gl, width, height, {
      needsGenerateMipmaps: true,
      minFilter: gl.NEAREST_MIPMAP_LINEAR,
      magFilter: gl.NEAREST
    }),
    createTexture2D(gl, width, height, {
      minFilter: gl.NEAREST,
      magFilter: gl.NEAREST,
      wrapS: gl.CLAMP_TO_EDGE,
      wrapT: gl.CLAMP_TO_EDGE
    })
  ];

  let readIndex = 0;

  return {
    textures,
    mipmappedTexture: textures[0],

    get read() {
      return textures[readIndex];
    },

    get write() {
      return textures[1 - readIndex];
    },

    // 交换读写纹理
    swap() {
      readIndex = 1 - readIndex;
    },

    // 复位到初始状态，配合内容清空可消除上一轮残留的模糊结果
    reset() {
      readIndex = 0;
    }
  };
}




/**
 * @param {WebGLRenderingContext} gl
 * @param {width} number
 * @param {height} number
 * @param {{
 *   needsGenerateMipmaps?: boolean
 *   magFilter?: number
 *   minFilter?: number
 *   wrapS?: number
 *   wrapT?: number
 * }} options
 * @returns {WebGLTexture}
 */
function createTexture2D(gl, width, height, { needsGenerateMipmaps, magFilter, minFilter, wrapS, wrapT } = {} ) {
  const texture = gl.createTexture();

  // 将创建的纹理绑定为当前上下文中的二维纹理对象
  gl.bindTexture( gl.TEXTURE_2D, texture );

  // WebGL 纹理坐标系 y 轴垂直向上，图片（如 PNG, JPG等）坐标系 y 轴垂直向下，所以需要对纹理图像做 Y 坐标翻转
  gl.pixelStorei( gl.UNPACK_FLIP_Y_WEBGL, true );

  gl.texImage2D( gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

  needsGenerateMipmaps && gl.generateMipmap(gl.TEXTURE_2D);

  // 设定纹理放大方法
  // gl.NEAREST
  magFilter && gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter );

  // 设定纹理缩小方法
  minFilter && gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter );

  // 设定纹理水平填充方法
  // gl.CLAMP_TO_EDGE
  wrapS && gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS );

  // 设定纹理水平垂直方法
  wrapT && gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT );

  return texture;
}
