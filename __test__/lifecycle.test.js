/* eslint no-undef: off */
/* eslint func-names: off */
import { jest } from '@jest/globals'
import H5VideoPlayer from '../src/index'

describe('lifecycle test', () => {
  beforeAll(() => {
    // mock playback state the same way the existing suite does: the style
    // mock makes every element share one class, so `els.video` resolves to a
    // div and play/pause/paused are mocked on HTMLDivElement. `isVideoPlaying`
    // also reads currentTime/readyState, so play() stubs those too.
    window.HTMLDivElement.prototype.load = () => {
      /* do nothing */
    }
    window.HTMLDivElement.prototype.play = function () {
      Object.defineProperty(this, 'paused', {
        configurable: true,
        get() {
          return false
        },
      })
      Object.defineProperty(this, 'currentTime', {
        configurable: true,
        get() {
          return 1
        },
      })
      Object.defineProperty(this, 'readyState', {
        configurable: true,
        get() {
          return 4
        },
      })
    }
    window.HTMLDivElement.prototype.pause = function () {
      Object.defineProperty(this, 'paused', {
        configurable: true,
        get() {
          return true
        },
      })
    }
  })

  const source = 'https://cycjimmy.github.io/staticFiles/media/Sony_test_video_1280x720.mp4'

  const createContext = () => {
    const context = document.createElement('div')
    document.body.appendChild(context)
    return context
  }

  const clickMask = player => player.els.mask
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))

  it('load twice with control: one mask click toggles playback exactly once', () => {
    const playHook = jest.fn()
    const pauseHook = jest.fn()
    const player = new H5VideoPlayer(source, {
      context: createContext(),
      control: true,
      hooks: {
        play: playHook,
        pause: pauseHook,
      },
    })

    player.load()
    player.load()

    clickMask(player)
    expect(playHook).toHaveBeenCalledTimes(1)
    expect(pauseHook).toHaveBeenCalledTimes(0)

    clickMask(player)
    expect(playHook).toHaveBeenCalledTimes(1)
    expect(pauseHook).toHaveBeenCalledTimes(1)

    player.destroy()
  })

  it('autoClose removes the container on ended; reload keeps a single listener set', () => {
    const playHook = jest.fn()
    const pauseHook = jest.fn()
    const stopHook = jest.fn()
    const context = createContext()
    const player = new H5VideoPlayer(source, {
      context,
      control: true,
      autoClose: true,
      hooks: {
        play: playHook,
        pause: pauseHook,
        stop: stopHook,
      },
    }).load()

    player.els.video.dispatchEvent(new window.Event('ended'))
    expect(stopHook).toHaveBeenCalledTimes(1)
    expect(context.contains(player.els.container)).toBe(false)

    player.load()
    expect(context.contains(player.els.container)).toBe(true)

    clickMask(player)
    expect(playHook).toHaveBeenCalledTimes(1)
    expect(pauseHook).toHaveBeenCalledTimes(0)

    clickMask(player)
    expect(playHook).toHaveBeenCalledTimes(1)
    expect(pauseHook).toHaveBeenCalledTimes(1)

    // a second ended after reload fires stop exactly once more
    player.els.video.dispatchEvent(new window.Event('ended'))
    expect(stopHook).toHaveBeenCalledTimes(2)
    expect(context.contains(player.els.container)).toBe(false)

    player.destroy()
  })

  it('destroy is idempotent and play/pause afterwards are silent no-ops', () => {
    const playHook = jest.fn()
    const pauseHook = jest.fn()
    const context = createContext()
    const player = new H5VideoPlayer(source, {
      context,
      control: true,
      hooks: {
        play: playHook,
        pause: pauseHook,
      },
    }).load()

    expect(() => player.destroy()).not.toThrow()
    expect(() => player.destroy()).not.toThrow()
    expect(context.contains(player.els.container)).toBe(false)

    expect(() => {
      player.play()
      player.pause()
    }).not.toThrow()
    expect(playHook).not.toHaveBeenCalled()
    expect(pauseHook).not.toHaveBeenCalled()

    // a stray click on the detached mask must not reach the hooks either
    clickMask(player)
    expect(playHook).not.toHaveBeenCalled()
    expect(pauseHook).not.toHaveBeenCalled()
  })

  it('mask click does not play when control is false and fixAndroidWechatContinue is off', () => {
    const playHook = jest.fn()
    const player = new H5VideoPlayer(source, {
      context: createContext(),
      control: false,
      hooks: {
        play: playHook,
      },
    }).load()

    clickMask(player)
    player.els.video.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))

    expect(playHook).not.toHaveBeenCalled()

    player.destroy()
  })
})
