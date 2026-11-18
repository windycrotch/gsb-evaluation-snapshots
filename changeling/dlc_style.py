"""Deep-Live-Cam's look for the face swap, as a choice beside the classic one (written anew after the ideas in
hacksider/Deep-Live-Cam; the same style as Mimic's and Changeling Studio's C++ swap):

- a soft oval instead of the feathered square, so no box corners show on the face
- the swapped face's colour and light matched to the face it replaces (Reinhard's transfer in Lab)
- your own mouth kept (talking, teeth and tongue look like you), reaching down towards the chin as far as you like
- a Poisson blend (the swapped face's gradients, the frame's own edge: no seam)
- opacity, sharpness, and smoothing between frames (video and the webcam: steadier, less flicker)

    style = Style(); style.on = True
    out = style.paste(frame, fake, m, face)        # fake, m: inswapper's get(..., paste_back=False)
"""
import cv2
import numpy as np

_ovals = {}


def oval(size):
    """The soft oval in the swap's square crop: axes 0.44 of the side, feathered by 12/128 of it."""
    if size not in _ovals:
        m = np.zeros((size, size), np.float32)
        cv2.ellipse(m, (size // 2, size // 2), (int(size * 0.44), int(size * 0.44)), 0, 0, 360, 1.0, -1)
        _ovals[size] = cv2.GaussianBlur(m, (0, 0), size * 12 / 128)
    return _ovals[size]


def colour_transfer(fake, original, mask):
    """The fake's Lab mean and spread made the original's, measured over the mask."""
    w = (mask > 0.05).astype(np.float32)[..., None]
    total = w.sum()
    if total < 16:
        return fake
    a = cv2.cvtColor(np.clip(fake, 0, 255).astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)
    b = cv2.cvtColor(np.clip(original, 0, 255).astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)
    ma, mb = (a * w).sum((0, 1)) / total, (b * w).sum((0, 1)) / total
    sa = np.sqrt((((a - ma) ** 2) * w).sum((0, 1)) / total) + 1e-3
    sb = np.sqrt((((b - mb) ** 2) * w).sum((0, 1)) / total) + 1e-3
    out = (a - ma) * np.clip(sb / sa, 0.5, 2.0) + mb
    return cv2.cvtColor(np.clip(out, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR).astype(np.float32)


class Style:
    def __init__(self):
        self.on = False            # False: the classic paste (the app's own)
        self.colour = True
        self.poisson = False
        self.mouth = False
        self.mouth_size = 0.3      # 0 the lips .. 1 down to the chin
        self.opacity = 1.0
        self.sharpness = 0.0
        self.smoothing = 0.3       # used when sequence is on (the webcam, a video read in order)
        self.sequence = False
        self._prev = []            # the last frame's faces: (centre x, centre y, size, crop)
        self._cur = []

    def new_frame(self):
        """Call once per frame of a sequence, before its faces."""
        self._prev, self._cur = self._cur, []

    def reset(self):
        self._prev, self._cur = [], []

    def _smooth(self, fake, box):
        cx, cy, size = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2, max(1.0, box[2] - box[0])
        s = min(max(self.smoothing, 0.0), 1.0) * 0.75          # never all of the last frame: it would freeze
        if s > 0:
            for px, py, ps, crop in self._prev:
                if crop.shape == fake.shape and np.hypot(px - cx, py - cy) < 0.25 * size and abs(ps - size) < 0.25 * size:
                    fake = fake * (1 - s) + crop * s
                    break
        self._cur.append((cx, cy, size, fake.copy()))
        return fake

    def paste(self, frame, fake, m, face, visible=None, strength=1.0):
        """frame with the swapped face (fake: the model's square crop, m: the frame -> crop alignment) put in."""
        size = fake.shape[0]
        original = cv2.warpAffine(frame, m, (size, size), borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
        mask = oval(size).copy()
        if visible is not None:                                  # hands, hair in front: the face not over them
            mask *= cv2.resize(visible, (size, size)) if visible.shape[0] != size else visible
        fake = fake.astype(np.float32)
        if self.colour:
            fake = colour_transfer(fake, original, mask)
        if self.sharpness > 0:
            blur = cv2.GaussianBlur(fake, (0, 0), max(1.0, size / 128))
            fake = np.clip(fake + (fake - blur) * self.sharpness * 1.5, 0, 255)
        if self.sequence:
            fake = self._smooth(fake, face.bbox)
        if self.poisson:
            core = (mask > 0.85).astype(np.uint8) * 255
            ys, xs = np.nonzero(core)
            if len(xs) > 16:
                centre = (int((xs.min() + xs.max()) / 2), int((ys.min() + ys.max()) / 2))
                try:
                    fake = cv2.seamlessClone(np.clip(fake, 0, 255).astype(np.uint8), np.clip(original, 0, 255).astype(np.uint8),
                                             core, centre, cv2.NORMAL_CLONE).astype(np.float32)
                except cv2.error:
                    pass
        # into the frame, only over the face's box
        h, w = frame.shape[:2]
        im = cv2.invertAffineTransform(m)
        corners = cv2.transform(np.float32([[[0, 0], [size, 0], [0, size], [size, size]]]), im)[0]
        x0, y0 = np.maximum(np.floor(corners.min(0)).astype(int) - 2, 0)
        x1, y1 = np.minimum(np.ceil(corners.max(0)).astype(int) + 2, (w, h))
        if x1 - x0 < 8 or y1 - y0 < 8:
            return frame
        im[:, 2] -= (x0, y0)
        bw, bh = x1 - x0, y1 - y0
        face_px = cv2.warpAffine(np.clip(fake, 0, 255).astype(np.uint8), im, (bw, bh), borderMode=cv2.BORDER_REPLICATE)
        alpha = cv2.warpAffine(mask, im, (bw, bh), borderValue=0.0)[..., None] * min(max(self.opacity, 0.0), 1.0) * strength
        out = frame.copy()
        roi = out[y0:y1, x0:x1].astype(np.float32)
        out[y0:y1, x0:x1] = (face_px.astype(np.float32) * alpha + roi * (1 - alpha)).astype(np.uint8)
        if self.mouth:
            out = self._keep_mouth(out, frame, face)
        return out

    def _keep_mouth(self, out, frame, face):
        """Your own mouth from the frame before the swap: an oval round the mouth corners (the detector's points 3 and
        4), reaching down towards the chin by mouth_size, feathered."""
        k = np.asarray(face.kps, np.float32)
        left, right, nose = k[3], k[4], k[2]
        c = (left + right) / 2
        width = float(np.linalg.norm(right - left))
        if width < 4:
            return out
        angle = float(np.degrees(np.arctan2(right[1] - left[1], right[0] - left[0])))
        down = float(np.linalg.norm(c - nose))                     # nose to mouth: about mouth to chin, too
        reach = min(max(self.mouth_size, 0.0), 1.0) * down * 0.9
        # the oval's centre moved down (along the face's own down) by half the reach
        n = np.array([-np.sin(np.radians(angle)), np.cos(np.radians(angle))], np.float32)
        centre = c + n * (reach / 2)
        axes = (width * 0.62, width * 0.32 + reach / 2)
        h, w = out.shape[:2]
        pad = int(max(axes) * 1.6) + 4
        x0, y0 = max(int(centre[0]) - pad, 0), max(int(centre[1]) - pad, 0)
        x1, y1 = min(int(centre[0]) + pad, w), min(int(centre[1]) + pad, h)
        if x1 - x0 < 4 or y1 - y0 < 4:
            return out
        m = np.zeros((y1 - y0, x1 - x0), np.float32)
        cv2.ellipse(m, (int(centre[0]) - x0, int(centre[1]) - y0), (int(axes[0]), int(axes[1])), angle, 0, 360, 1.0, -1)
        m = cv2.GaussianBlur(m, (0, 0), max(2.0, width * 0.12))[..., None]
        roi = out[y0:y1, x0:x1].astype(np.float32)
        own = frame[y0:y1, x0:x1].astype(np.float32)
        out[y0:y1, x0:x1] = (own * m + roi * (1 - m)).astype(np.uint8)
        return out
