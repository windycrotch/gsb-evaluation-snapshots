import { toggleClass } from '../utils/dom';
import { off, on } from '../utils/events';
import is from '../utils/is';

class PictureInPicture {
  constructor(player) {
    this.player = player;
    this.active = false;
    this.destroyed = false;

    this.init();
  }

  get supported() {
    const { media } = this.player;

    return Boolean(media && is.function(media.requestPictureInPicture) && document.pictureInPictureEnabled);
  }

  init = () => {
    const { player } = this;
    const button = player.controls.pictureInPicture;

    if (!this.supported) {
      button.style.display = 'none';
      return;
    }

    button.style.display = 'inline-block';

    on.call(player, button, 'click', this.toggle);
    on.call(player, player.media, 'enterpictureinpicture', this.onEnter);
    on.call(player, player.media, 'leavepictureinpicture', this.onLeave);
  };

  toggle = () => {
    if (this.destroyed || !this.supported) {
      return;
    }

    if (this.active) {
      this.exit();
    } else {
      this.enter();
    }
  };

  enter = () => {
    if (this.destroyed || !this.supported || this.active) {
      return;
    }

    const request = this.player.media.requestPictureInPicture();

    if (request && is.function(request.catch)) {
      request.catch(() => {});
    }
  };

  exit = () => {
    if (this.destroyed || !this.active || !is.function(document.exitPictureInPicture)) {
      return;
    }

    const request = document.exitPictureInPicture();

    if (request && is.function(request.catch)) {
      request.catch(() => {});
    }
  };

  onEnter = () => {
    if (this.destroyed) {
      return;
    }

    this.active = true;
    this.sync();
  };

  onLeave = () => {
    if (this.destroyed) {
      return;
    }

    this.active = false;
    this.sync();
  };

  sync = () => {
    const { player } = this;

    if (!player.controls || !player.controls.pictureInPicture) {
      return;
    }

    const button = player.controls.pictureInPicture;
    const caption = player.config.captions[this.active ? 'exitPictureInPicture' : 'pictureInPicture'];

    toggleClass(button, 'fluid_button_picture_in_picture', !this.active);
    toggleClass(button, 'fluid_button_picture_in_picture_exit', this.active);
    button.setAttribute('aria-pressed', String(this.active));
    button.setAttribute('aria-label', caption);

    if (player.controls.pictureInPictureTooltip) {
      player.controls.pictureInPictureTooltip.textContent = caption;
    }
  };

  destroy = () => {
    if (this.destroyed) {
      return;
    }

    const { player } = this;

    // Leave picture in picture while the media element is still valid
    if (this.active && is.function(document.exitPictureInPicture)) {
      const request = document.exitPictureInPicture();

      if (request && is.function(request.catch)) {
        request.catch(() => {});
      }
    }

    this.destroyed = true;
    this.active = false;

    if (player.controls && player.controls.pictureInPicture) {
      off(player.controls.pictureInPicture, 'click', this.toggle);
      toggleClass(player.controls.pictureInPicture, 'fluid_button_picture_in_picture', true);
      toggleClass(player.controls.pictureInPicture, 'fluid_button_picture_in_picture_exit', false);
      player.controls.pictureInPicture.setAttribute('aria-pressed', 'false');
    }

    if (player.media) {
      off(player.media, 'enterpictureinpicture', this.onEnter);
      off(player.media, 'leavepictureinpicture', this.onLeave);
    }
  };
}

export default PictureInPicture;
