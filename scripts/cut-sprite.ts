// Turns a hand picture on a flat magenta background into a pixel-art sprite with transparency.
// The source is a crop of the reference frame, cleaned by an image model. One sprite pixel is one render pixel.
//
//   bun scripts/cut-sprite.ts <input> <output.png> <width> <height>
import sharp from 'sharp'

const COLOURS = 40
const OPAQUE_SHARE = 0.5

const [input, output, widthArg, heightArg] = process.argv.slice(2)
if (!input || !output || !widthArg || !heightArg) {
  console.error('usage: bun scripts/cut-sprite.ts <input> <output.png> <width> <height>')
  process.exit(1)
}
const width = Number(widthArg)
const height = Number(heightArg)

/** magenta key, loose enough for JPEG noise and the pink fringe around edges */
function isBackground(r: number, g: number, b: number) {
  return r > 90 && b > 90 && g < Math.min(r, b) * 0.75 && Math.abs(r - b) < 90
}

console.log(`reading ${input}`)
const source = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true })
const { data, info } = source
console.log(`source is ${info.width} x ${info.height}, sprite is ${width} x ${height}`)

// Each sprite pixel is the average of the subject pixels in its source block.
const sprite = Buffer.alloc(width * height * 4)
let opaque = 0
for (let y = 0; y < height; y++) {
  const y0 = Math.floor((y * info.height) / height)
  const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * info.height) / height))
  for (let x = 0; x < width; x++) {
    const x0 = Math.floor((x * info.width) / width)
    const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * info.width) / width))
    let r = 0
    let g = 0
    let b = 0
    let subject = 0
    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const i = (sy * info.width + sx) * 3
        if (isBackground(data[i], data[i + 1], data[i + 2])) continue
        r += data[i]
        g += data[i + 1]
        b += data[i + 2]
        subject++
      }
    }
    if (subject < (y1 - y0) * (x1 - x0) * OPAQUE_SHARE) continue
    sprite.set([r / subject, g / subject, b / subject, 255], (y * width + x) * 4)
    opaque++
  }
}
console.log(`keyed out the background: ${opaque} of ${width * height} pixels are opaque`)

// Edge pixels that mixed with the magenta keep a pink tint: drop them.
const alpha = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : sprite[(y * width + x) * 4 + 3])
const fringe: number[] = []
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    if (sprite[i + 3] === 0) continue
    const onEdge = !alpha(x - 1, y) || !alpha(x + 1, y) || !alpha(x, y - 1) || !alpha(x, y + 1)
    const tinted = sprite[i] > sprite[i + 1] * 1.3 && sprite[i + 2] > sprite[i + 1] * 1.3
    if (onEdge && tinted) fringe.push(i)
  }
}
for (const i of fringe) sprite[i + 3] = 0
console.log(`dropped ${fringe.length} pink fringe pixels`)

await sharp(sprite, { raw: { width, height, channels: 4 } })
  .png({ palette: true, colours: COLOURS, dither: 0 })
  .toFile(output)
console.log(`wrote ${output}`)
