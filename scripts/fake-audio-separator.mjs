// Test double for the `audio-separator` CLI, used by src/main/stems.test.ts.
//
// stems.ts spawns `<bin> <trackPath> --model_filename M --output_dir D ...`.
// The test points STEMDECK_AUDIO_SEPARATOR at the Node executable and uses a
// copy of this script as the track path, so this file runs as:
//   node <this-script> --model_filename M --output_dir D ...
//
// Behaviour is steered through the environment (inherited from the test):
//   FAKE_SEP_LOG         file to append one JSON line per invocation to
//   FAKE_SEP_DURATION_MS how long the fake run takes (progress ticks included)
//   FAKE_SEP_FAIL        when set, exit with this code instead of writing stems
import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import path from 'path'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const model = opt('--model_filename') ?? 'unknown'
const outDir = opt('--output_dir')
const durationMs = Number(process.env.FAKE_SEP_DURATION_MS ?? '100')

if (process.env.FAKE_SEP_LOG) {
  appendFileSync(
    process.env.FAKE_SEP_LOG,
    JSON.stringify({ pid: process.pid, model, outDir, argv: args }) + '\n'
  )
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const steps = 5
  for (let i = 1; i <= steps; i++) {
    // tqdm-style carriage-return progress, like the real separator
    process.stderr.write(`Separating... ${Math.round((i / steps) * 100)}%\r`)
    await sleep(durationMs / steps)
  }

  if (process.env.FAKE_SEP_FAIL) {
    console.error('fake-separator: something went horribly wrong')
    process.exit(Number(process.env.FAKE_SEP_FAIL))
  }

  mkdirSync(outDir, { recursive: true })
  const stems = model.includes('htdemucs')
    ? ['Vocals', 'Drums', 'Bass', 'Other']
    : ['Vocals', 'Instrumental']
  for (const stem of stems) {
    writeFileSync(path.join(outDir, `Song (${stem}).wav`), `fake ${stem} audio`)
  }
  console.log('Separation complete!')
}

main()
