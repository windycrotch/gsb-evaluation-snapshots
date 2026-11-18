const { expect, test } = require('@playwright/test');

const mockPictureInPicture = () => {
  window.pipElement = null;
  window.exitPictureInPictureCalls = 0;

  Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true });
  Object.defineProperty(document, 'pictureInPictureElement', {
    configurable: true,
    get() {
      return window.pipElement;
    },
  });
  Object.defineProperty(document, 'exitPictureInPicture', {
    configurable: true,
    value() {
      window.exitPictureInPictureCalls++;
      const element = window.pipElement;
      window.pipElement = null;

      if (element) {
        element.dispatchEvent(new Event('leavepictureinpicture'));
      }

      return Promise.resolve();
    },
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', {
    configurable: true,
    value() {
      window.pipElement = this;
      this.dispatchEvent(new Event('enterpictureinpicture'));
      return Promise.resolve({});
    },
  });
};

const setupPage = async (page, mock) => {
  await page.goto('/');
  await page.setContent('<video id="player" width="320" height="180"></video>');

  if (mock) {
    await page.evaluate(mockPictureInPicture);
  } else {
    await page.evaluate(() => {
      Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: false });
      Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', {
        configurable: true,
        value: undefined,
      });
    });
  }

  await page.addScriptTag({ url: '/player.min.js' });
};

test('picture in picture toggles aria-pressed on enter and leave', async ({ page }) => {
  await setupPage(page, true);

  const state = await page.evaluate(() => {
    window.fluidPlayer('player');
    const button = document.querySelector('.fluid_control_picture_in_picture');
    const visible = getComputedStyle(button).display !== 'none';
    const initial = {
      pressed: button.getAttribute('aria-pressed'),
      label: button.getAttribute('aria-label'),
    };

    button.click();
    const entered = {
      pressed: button.getAttribute('aria-pressed'),
      label: button.getAttribute('aria-label'),
      exitClass: button.classList.contains('fluid_button_picture_in_picture_exit'),
      enterClass: button.classList.contains('fluid_button_picture_in_picture'),
    };

    button.click();
    const exited = {
      pressed: button.getAttribute('aria-pressed'),
      label: button.getAttribute('aria-label'),
      exitClass: button.classList.contains('fluid_button_picture_in_picture_exit'),
      enterClass: button.classList.contains('fluid_button_picture_in_picture'),
    };

    return { visible, initial, entered, exited };
  });

  expect(state.visible).toBe(true);
  expect(state.initial).toEqual({ pressed: 'false', label: 'Picture in Picture' });
  expect(state.entered).toEqual({
    pressed: 'true',
    label: 'Exit Picture in Picture',
    exitClass: true,
    enterClass: false,
  });
  expect(state.exited).toEqual({
    pressed: 'false',
    label: 'Picture in Picture',
    exitClass: false,
    enterClass: true,
  });
});

test('picture in picture button is hidden when unsupported', async ({ page }) => {
  await setupPage(page, false);

  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const display = await page.evaluate(() => {
    window.fluidPlayer('player');
    return getComputedStyle(document.querySelector('.fluid_control_picture_in_picture')).display;
  });

  expect(display).toBe('none');
  expect(errors).toEqual([]);
});

test('destroy exits picture in picture and late native events are inert', async ({ page }) => {
  await setupPage(page, true);

  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const state = await page.evaluate(async () => {
    const player = window.fluidPlayer('player');
    const video = document.getElementById('player');
    const button = document.querySelector('.fluid_control_picture_in_picture');

    button.click();
    const pressedDuring = button.getAttribute('aria-pressed');

    await player.destroy();

    // Native events after destroy must not touch the released player
    video.dispatchEvent(new Event('enterpictureinpicture'));
    video.dispatchEvent(new Event('leavepictureinpicture'));

    return {
      pressedDuring,
      pipElement: window.pipElement,
      exitCalls: window.exitPictureInPictureCalls,
    };
  });

  expect(state.pressedDuring).toBe('true');
  expect(state.pipElement).toBe(null);
  expect(state.exitCalls).toBe(1);
  expect(errors).toEqual([]);
});

test('switching source exits picture in picture', async ({ page }) => {
  await setupPage(page, true);

  const state = await page.evaluate(() => {
    const player = window.fluidPlayer('player');
    document.querySelector('.fluid_control_picture_in_picture').click();

    player.src('https://example.com/video.mp4');

    return {
      pipElement: window.pipElement,
      exitCalls: window.exitPictureInPictureCalls,
      pressed: document.querySelector('.fluid_control_picture_in_picture').getAttribute('aria-pressed'),
    };
  });

  expect(state).toEqual({ pipElement: null, exitCalls: 1, pressed: 'false' });
});

test('entering fullscreen exits picture in picture', async ({ page }) => {
  await setupPage(page, true);

  const state = await page.evaluate(() => {
    const player = window.fluidPlayer('player', { layoutControls: { fullscreen: { fallback: 'force' } } });
    document.querySelector('.fluid_control_picture_in_picture').click();

    player.toggleFullScreen();

    return {
      pipElement: window.pipElement,
      exitCalls: window.exitPictureInPictureCalls,
      fullscreen: document.querySelector('.fluid_video_wrapper').classList.contains('fluid_fullscreen_fallback'),
    };
  });

  expect(state).toEqual({ pipElement: null, exitCalls: 1, fullscreen: true });
});
