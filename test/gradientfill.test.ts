import { describe, expect, beforeEach, it } from "vitest";
import * as pureimage from "../src/index.js";
import { NAMED_COLORS } from "../src/named_colors";
import { save } from "./common";

describe("drawing gradients", () => {
  let image;
  let c;
  let w = 200;
  let h = 200;
  beforeEach(() => {
    image = pureimage.make(w, h);
    c = image.getContext("2d");
    c.fillStyle = "black";
    c.fillRect(0, 0, w, h);
  });

  it("fillRect with linear gradient", async () => {
    const grad = c.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, "white");
    grad.addColorStop(1, "blue");
    c.fillStyle = grad;
    c.fillRect(0, 0, w, h);
    expect(image.getPixelRGBA(0, 0)).to.eq(0xffffffff);
    // expect(image.getPixelRGBA(w-1, h-1)).to.eq(0x0000FFFF)
    await save(image, "linear_gradient_fillrect");
  });

  it("fill with linear gradient", async () => {
    c.imageSmoothingEnabled = true;
    const grad = c.createLinearGradient(0, 0, 20, 20);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(1, "blue");
    c.fillStyle = grad;
    c.beginPath();
    c.rect(0, 0, 20, 20);
    c.fill();
    // expect(image.getPixelRGBA(0, 0)).to.eq(NAMED_COLORS.white)
    expect(image.getPixelRGBA(19, 19)).to.eq(0x0c0cffff);
    // console.log(image)
    // for(let i=0; i<20; i++) {
    //     console.log(i, image.getPixelRGBA_separate(i,19))
    // }
    await save(image, "linear_gradient_fill.png");
  });

  it("linear gradient with multiple stops", async () => {
    const grad = c.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "#ff0000");
    grad.addColorStop(0.5, "#00ff00");
    grad.addColorStop(1, "#0000ff");
    c.fillStyle = grad;
    c.fillRect(0, 0, w, h);
    await save(image, "linear_gradient_rgb_stops.png");
  });

  // it('stroke with linear gradient',async () => {
  //     c.imageSmoothingEnabled = true
  //     const grad = c.createLinearGradient(0, 0, 20, 20)
  //     grad.addColorStop(0, 'white')
  //     grad.addColorStop(1, 'blue')
  //     // c.fillStyle = grad
  //     // c.fillStyle = 'red'
  //     c.strokeStyle = grad
  //     // c.strokeStyle = 'red'
  //     c.lineWidth = 3
  //     c.beginPath()
  //     c.rect(5, 5, 10, 10)
  //     c.stroke()
  //
  //     await save(image, 'linar_gradient_stroke.png')
  // })

  it("is making a radial gradient", async () => {
    const grad = c.createRadialGradient(10, 10, 5, 10, 10, 10);
    grad.addColorStop(0, "white");
    grad.addColorStop(1, "green");
    c.imageSmoothingEnabled = false;
    c.fillStyle = grad;
    c.fillRect(0, 0, 20, 20);

    // expect(image.getPixelRGBA(0, 0)).to.eq(NAMED_COLORS.green)
    // expect(image.getPixelRGBA(10, 10)).to.eq(NAMED_COLORS.white)
    await save(image, "radial_gradient_fillrect.png");
  });

  it("is drawing a conical gradient with smooth colors", async () => {
    const grad = c.createConicGradient(0, w / 2, h / 2);
    grad.addColorStop(0, "white");
    grad.addColorStop(1, "blue");
    c.fillStyle = grad;
    c.fillRect(0, 0, w, h);
    await save(image, "conic_gradient_smooth");
  });
  it("is drawing a conical gradient with a different angle", async () => {
    const grad = c.createConicGradient(Math.PI / 3, w / 2, h / 2);
    grad.addColorStop(0, "white");
    grad.addColorStop(1, "blue");
    c.fillStyle = grad;
    c.fillRect(0, 0, w, h);
    await save(image, "conic_gradient_smooth_90");
  });
  it("is drawing a conical gradient with hard colors", async () => {
    const grad = c.createConicGradient(Math.PI / 3, w / 2, h / 2);
    grad.addColorStop(0, "#f00");
    grad.addColorStop(0.2, "#00f");
    grad.addColorStop(0.4, "#0ff");
    grad.addColorStop(0.6, "#f0f");
    grad.addColorStop(0.8, "#ff0");
    grad.addColorStop(1, "#f00");
    // grad.addColorStop(0, "#f00");
    // grad.addColorStop(0.2, "#00f");
    // grad.addColorStop(0.4, "#0ff");
    // grad.addColorStop(0.6, "#f0f");
    // grad.addColorStop(0.8, "#ff0");
    // grad.addColorStop(1, "#f00");
    c.fillStyle = grad;
    c.fillRect(0, 0, w, h);
    await save(image, "conic_gradient_smooth_rainbow");
  });
  it("is drawing a conical gradient with one color", async () => {});

  it("interpolates alpha from rgba() color stops", () => {
    const grad = c.createLinearGradient(0, 0, 10, 0);
    grad.addColorStop(0, "rgba(255, 0, 0, 0)");
    grad.addColorStop(1, "rgba(255, 0, 0, 1)");
    // direct gradient lookup: alpha must be interpolated, not forced to 255
    expect(grad.colorAt(0, 0)).to.eq(0xff000000);
    expect(grad.colorAt(5, 0)).to.eq(0xff00007f);
    expect(grad.colorAt(10, 0)).to.eq(0xff0000ff);
  });

  it("interpolates alpha from #rrggbbaa color stops", () => {
    const grad = c.createLinearGradient(0, 0, 10, 0);
    grad.addColorStop(0, "#ff000000");
    grad.addColorStop(1, "#ff000080");
    expect(grad.colorAt(0, 0)).to.eq(0xff000000);
    expect(grad.colorAt(5, 0)).to.eq(0xff000040);
    expect(grad.colorAt(10, 0)).to.eq(0xff000080);
  });

  it("renders semi-transparent gradient stops through fillRect and composites with globalAlpha", () => {
    const grad = c.createLinearGradient(0, 0, 10, 0);
    grad.addColorStop(0, "rgba(255, 0, 0, 0)");
    grad.addColorStop(1, "rgba(255, 0, 0, 1)");
    c.fillStyle = grad;
    c.globalAlpha = 1;
    c.fillRect(0, 0, 10, 1);
    // midpoint: source r=255 a=127 over opaque black -> r=127, stored alpha stays opaque
    expect(image.getPixelRGBA(5, 0)).to.eq(0x7f0000ff);

    // reset and draw again with globalAlpha 0.5: RGB contribution is halved
    c.fillStyle = "black";
    c.globalAlpha = 1;
    c.fillRect(0, 0, 10, 1);
    c.fillStyle = grad;
    c.globalAlpha = 0.5;
    c.fillRect(0, 0, 10, 1);
    expect(image.getPixelRGBA(5, 0)).to.eq(0x3f0000ff);
  });

  it("renders a semi-transparent gradient through beginPath/rect/fill", () => {
    // both rasterizers (noaa and aa) should resolve the gradient per pixel
    for (const smoothing of [false, true]) {
      const image = pureimage.make(20, 20);
      const c = image.getContext("2d");
      c.fillStyle = "black";
      c.fillRect(0, 0, 20, 20);
      c.imageSmoothingEnabled = smoothing;
      const grad = c.createLinearGradient(0, 0, 10, 0);
      grad.addColorStop(0, "rgba(255, 0, 0, 0)");
      grad.addColorStop(1, "rgba(255, 0, 0, 1)");
      c.fillStyle = grad;
      c.beginPath();
      c.rect(0, 0, 10, 10);
      c.fill();
      expect(image.getPixelRGBA(5, 5)).to.eq(0x7f0000ff);
    }
  });

  it("renders a gradient through fillRect under a non-identity transform", () => {
    c.translate(5, 0);
    // the gradient is evaluated at device coordinates, so span 5..15 there
    const grad = c.createLinearGradient(5, 0, 15, 0);
    grad.addColorStop(0, "rgba(255, 0, 0, 0)");
    grad.addColorStop(1, "rgba(255, 0, 0, 1)");
    c.fillStyle = grad;
    // exercises the non-identity fillRect branch (path fill -> colorAt)
    c.fillRect(0, 0, 10, 1);
    // translated midpoint lands at device x = 10, the gradient midpoint
    expect(image.getPixelRGBA(10, 0)).to.eq(0x7f0000ff);
  });

  it("handles color stops added out of order", () => {
    const grad = c.createLinearGradient(0, 0, 100, 0);
    // intentionally inserted in a shuffled order
    grad.addColorStop(1, "#0000ff");
    grad.addColorStop(0, "#ff0000");
    grad.addColorStop(0.5, "#00ff00");
    // endpoints
    expect(grad.colorAt(0, 0)).to.eq(0xff0000ff);
    expect(grad.colorAt(100, 0)).to.eq(0x0000ffff);
    // exact middle stop, no jump
    expect(grad.colorAt(50, 0)).to.eq(0x00ff00ff);
    // halfway between the red and green stops
    expect(grad.colorAt(25, 0)).to.eq(0x7f7f00ff);
  });

  it("uses a single color stop for the whole area", () => {
    const grad = c.createLinearGradient(0, 0, 10, 0);
    grad.addColorStop(0.5, "rgba(10, 20, 30, 0.5)");
    // rgba(..., 0.5) parses to byte 127; every position uses the sole stop
    expect(grad.colorAt(0, 0)).to.eq(0x0a141e7f);
    expect(grad.colorAt(5, 0)).to.eq(0x0a141e7f);
    expect(grad.colorAt(10, 0)).to.eq(0x0a141e7f);

    // also through the renderer: (10,20,30) at alpha 127 over opaque black
    c.fillStyle = grad;
    c.fillRect(0, 0, 5, 1);
    expect(image.getPixelRGBA(2, 0)).to.eq(0x04090eff);
  });

  it("uses the nearest endpoint color when queried outside the stop range", () => {
    const grad = c.createLinearGradient(0, 0, 100, 0);
    // stops do not cover the full 0..1 offset range
    grad.addColorStop(0.25, "#ff0000");
    grad.addColorStop(0.75, "#0000ff");
    // direct interpolation helper must not throw when no start stop is found
    expect(grad._lerpStops(0)).to.eq(0xff0000ff);
    expect(grad._lerpStops(1)).to.eq(0x0000ffff);
    // colorAt clamps geometry to 0..1 and still resolves to endpoint colors
    expect(grad.colorAt(0, 0)).to.eq(0xff0000ff);
    expect(grad.colorAt(100, 0)).to.eq(0x0000ffff);
  });

  it("keeps alpha interpolation for radial and conical gradients", () => {
    const radial = c.createRadialGradient(0, 0, 0, 0, 0, 10);
    radial.addColorStop(0, "rgba(0, 0, 0, 0)");
    radial.addColorStop(1, "rgba(0, 0, 0, 1)");
    // distance 5 -> t = 0.5
    expect(radial.colorAt(5, 0)).to.eq(0x0000007f);

    const conic = c.createConicGradient(0, 0, 0);
    conic.addColorStop(0, "rgba(0, 0, 0, 0)");
    conic.addColorStop(1, "rgba(0, 0, 0, 1)");
    // atan2 == start angle (point on the -x axis) is offset t = 0; the
    // opposite direction is t = 0.5 and no query is allowed to throw
    expect(conic.colorAt(-1, 0)).to.eq(0x00000000);
    expect(conic.colorAt(1, 0)).to.eq(0x0000007f);
  });
});
