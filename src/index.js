import addStyles from '@cycjimmy/awesome-js-funcs/dom/addStyles'
import isString from '@cycjimmy/awesome-js-funcs/judgeBasic/isString'
import isVideoPlaying from '@cycjimmy/awesome-js-funcs/media/isVideoPlaying'

import style from './style/index.module.scss'
import playButtonTemplate from './templates/playButton'
import wrapperTemplate from './templates/wrapper'

// Guarded so the ESM bundle can be imported outside a browser (SSR, tooling).
const _orientationchangeEvt = typeof window !== 'undefined' && 'onorientationchange' in window
  ? 'orientationchange'
  : 'resize'

function _judgePhoneOrientation() {
  const { clientWidth } = document.documentElement
  const { clientHeight } = document.documentElement
  return clientWidth > clientHeight
    ? 'landscape'
    : 'portrait'
}

function _getElementStyle(el, styleName) {
  return window
    .getComputedStyle(el, null)
    .getPropertyValue(styleName)
}

export default class H5VideoPlayer {
  /**
   * Create a player instance.
   *
   * @param source The video source: a url string, a `{ url, type }` object, or an array of those.
   * @param options The player options.
   * @param options.context The element, or its selector, the player is mounted into.
   * @param options.control Whether the built-in controls are shown.
   * @param options.autoPlay Whether playback starts right after `load()`.
   * @param options.autoClose Whether the player closes when the video ends.
   * @param options.preload Whether the player is appended to the context on construction.
   * @param options.orientation `'portrait'` or `'landscape'`.
   * @param options.aspectRatio The video aspect ratio; defaults from `orientation` when falsy.
   * @param options.disableRotation Whether automatic phone rotation handling is enabled.
   * @param options.picMode Whether the play button is hidden.
   * @param options.fixAndroidWechatContinue Whether the Android WeChat pause workaround is enabled.
   * @param options.hooks The playback hook callbacks.
   */
  constructor(source, options = {}) {
    const {
      context = 'body',
      control = false,
      autoPlay = false,
      autoClose = true,
      preload = true,
      orientation = 'portrait',
      aspectRatio = 0,
      disableRotation = false,
      picMode = false,
      fixAndroidWechatContinue = false,
      hooks = {},
    } = options

    this.context = isString(context)
      ? document.querySelector(context)
      : context
    this.options = {
      source,
      control,
      autoPlay,
      autoClose,
      preload,
      orientation,
      aspectRatio: aspectRatio || (() => (orientation === 'landscape'
        ? 16 / 9
        : 9 / 16))(),
      disableRotation,
      picMode,
      fixAndroidWechatContinue,
    }

    this.hooks = {
      play: () => {},
      pause: () => {},
      stop: () => {},
      ...hooks,
    }

    // set context position
    if (_getElementStyle(this.context, 'position') === 'static') {
      this.context.style.position = 'relative'
    }

    this.els = {
      container: null,
      wrapper: null,
      video: null,
      videoWrapperForConstraintRatio: null,
      mask: null,
      playButton: null,
    }

    // lifecycle flags: make load()/close/destroy() predictable and idempotent
    this._eventsBound = false
    this._loaded = false
    this._closed = false
    this._destroyed = false
    this._orientationBound = false

    // Stable handler references so listeners can be removed again and are
    // never bound twice on the same instance.
    this._onMaskClick = () => {
      if (this._isPlaying()) {
        this.pause()
      }
      else {
        this.play()
      }
    }
    this._onPlayButtonClick = () => {
      this.play()
    }
    this._onVideoClick = () => {
      if (!this._isPlaying()) {
        this.play()
      }
    }
    this._onEnded = () => {
      this._showPlayBtn()
      if (this.options.autoClose) {
        this._close()
      }
      this.hooks.stop()
    }
    this._onOrientationChange = () => {
      window.removeEventListener(_orientationchangeEvt, this._onOrientationChange)

      setTimeout(() => {
        if (this._destroyed) {
          this._orientationBound = false
          return
        }
        this._changeWrapperStyle()
        window.addEventListener(_orientationchangeEvt, this._onOrientationChange, false)
      }, 400)
    }

    this.initContainer()
    this.initWrapper()

    if (this.options.preload) {
      this.init()
    }
  }

  initContainer() {
    // container
    this.els.container = document.createElement('div')
    this.els.container.classList.add(style.container)
  }

  initWrapper() {
    // wrapper
    this.els.wrapper = document.createElement('div')
    this.els.wrapper.classList.add(style.wrapper)

    this.els.wrapper.innerHTML = wrapperTemplate({
      source: this.options.source,
      orientation: this.options.orientation,
      style,
    })
    this.els.container.appendChild(this.els.wrapper)

    // video
    this.els.videoWrapperForConstraintRatio = this.els.wrapper.querySelector(`.${style.videoWrapperForConstraintRatio}`)
    this.els.video = this.els.wrapper.querySelector(`.${style.video}`)

    // mask: used to control video
    this.els.mask = document.createElement('div')
    this.els.mask.classList.add(style.mask)
    this.els.container.appendChild(this.els.mask)

    // playButton
    if (this.options.control) {
      this.els.playButton = document.createElement('div')
      this.els.playButton.classList.add(style.playButtonWrapper)

      // picMode
      if (!this.options.picMode) {
        this.els.playButton.innerHTML = playButtonTemplate({
          style,
        })
      }

      this.els.container.appendChild(this.els.playButton)
    }
  }

  init() {
    this.context.appendChild(this.els.container)
  }

  load() {
    if (this._destroyed) {
      return this
    }

    // A repeated load() on a live instance must not stack listeners or
    // re-fire hooks; only a closed/removed instance is re-mounted.
    const alreadyLoaded = this._loaded
      && !this._closed
      && this.context.contains(this.els.container)

    if (!this.context.contains(this.els.container)) {
      this.init()
    }

    this.els.container.classList.add(style.show)
    this._assignWrapperStyle()

    this.eventBind()

    if (this.options.autoPlay && !alreadyLoaded) {
      this.play()
    }

    this._loaded = true
    this._closed = false

    return this
  }

  eventBind() {
    if (this._destroyed || this._eventsBound) {
      return
    }

    if (this.options.control) {
      this.els.mask.addEventListener('click', this._onMaskClick)
      this.els.playButton.addEventListener('click', this._onPlayButtonClick)
    }
    else if (this.options.fixAndroidWechatContinue) {
      this.els.video.addEventListener('click', this._onVideoClick)
    }

    this.els.video.addEventListener('ended', this._onEnded)

    this._eventsBound = true
  }

  eventUnbind() {
    if (!this._eventsBound) {
      return
    }

    if (this.options.control) {
      this.els.mask.removeEventListener('click', this._onMaskClick)
      if (this.els.playButton) {
        this.els.playButton.removeEventListener('click', this._onPlayButtonClick)
      }
    }
    else if (this.options.fixAndroidWechatContinue) {
      this.els.video.removeEventListener('click', this._onVideoClick)
    }

    this.els.video.removeEventListener('ended', this._onEnded)

    this._eventsBound = false
  }

  play() {
    if (this._destroyed) {
      return
    }
    this.els.video.play()
    this._hiddenPlayBtn()
    this.hooks.play()
  }

  pause() {
    if (this._destroyed) {
      return
    }
    this.els.video.pause()
    this._showPlayBtn()
    this.hooks.pause()
  }

  /**
   * Tear the instance down: remove the container and every listener.
   * Idempotent — safe to call multiple times.
   *
   * @returns The player instance.
   */
  destroy() {
    if (this._destroyed) {
      return this
    }
    this._destroyed = true

    this.eventUnbind()

    if (this._orientationBound) {
      window.removeEventListener(_orientationchangeEvt, this._onOrientationChange)
      this._orientationBound = false
    }

    this._remove()

    this._loaded = false
    this._closed = true

    return this
  }

  _showPlayBtn() {
    if (this.els.playButton) {
      this.els.playButton.style.display = 'block'
    }
  }

  _hiddenPlayBtn() {
    if (this.els.playButton) {
      this.els.playButton.style.display = 'none'
    }
  }

  _isPlaying() {
    return isVideoPlaying(this.els.video)
  }

  _remove() {
    if (this.els.container && this.els.container.parentNode) {
      this.els.container.parentNode.removeChild(this.els.container)
    }
  }

  /**
   * Close a live instance: drop every listener and detach the container so a
   * later load() starts from a clean, single-listener state.
   */
  _close() {
    this.eventUnbind()
    this._remove()
    this._loaded = false
    this._closed = true
  }

  _changeWrapperStyle() {
    const containerRect = this.els.container.getBoundingClientRect()
    const containerRectWidth = containerRect.width
    const containerRectHeight = containerRect.height
    if (_judgePhoneOrientation() === this.options.orientation) {
      addStyles(this.els.wrapper, {
        width: `${containerRectWidth}px`,
        height: `${containerRectHeight}px`,
        transform: '',
      })
    }
    else {
      // Adjust the video orientation
      addStyles(this.els.wrapper, {
        width: `${containerRectHeight}px`,
        height: `${containerRectWidth}px`,
        transform: 'rotate(-90deg)',
      })
    }

    // set videoWrapperForConstraintRatio width&height
    setTimeout(() => {
      if (this._destroyed) {
        return
      }
      const wrapperWidth = Number.parseInt(this.els.wrapper.style.width, 10)
      const wrapperHeight = Number.parseInt(this.els.wrapper.style.height, 10)
      const preComputedHeight = wrapperWidth / this.options.aspectRatio
      if (preComputedHeight >= wrapperHeight) { // based on wrapperWidth
        addStyles(this.els.videoWrapperForConstraintRatio, {
          width: `${wrapperWidth}px`,
          height: `${preComputedHeight}px`,
        })
      }
      else { // based on wrapperHeight
        addStyles(this.els.videoWrapperForConstraintRatio, {
          width: `${wrapperHeight * this.options.aspectRatio}px`,
          height: `${wrapperHeight}px`,
        })
      }
    }, 0)
  }

  _assignWrapperStyle() {
    if (this.options.disableRotation) {
      this._changeWrapperStyle()
      if (!this._orientationBound) {
        window.addEventListener(_orientationchangeEvt, this._onOrientationChange, false)
        this._orientationBound = true
      }
    }
    else {
      const containerRect = this.els.container.getBoundingClientRect()
      addStyles(this.els.wrapper, {
        width: `${containerRect.width}px`,
        height: `${containerRect.height}px`,
      })
    }
  }
}
