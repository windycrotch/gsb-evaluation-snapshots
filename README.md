# please just text me

**[pleasejusttext.me](https://pleasejusttext.me)** — got another voice message? Reply just as inconveniently:
type your answer and get a video of hands slowly typing it on a phone. To read it, they’ll have to watch.

Available in English, Russian, Spanish and French.

## How it works

Everything happens **in the browser, on the user’s device** — there is no backend that sees the text.

1. **Timeline** — the text is turned into a deterministic sequence of key presses on an iOS-like keyboard
   (shift, caps lock, `123` page, 🌐 layout switch, long-press accents, typos with backspace, grandpa’s
   one-finger hunting). Seeded PRNG, so the same seed gives the same video.
2. **Renderer** — `renderFrame(ctx, timeline, t)` draws one frame into any Canvas 2D context.
   It has no DOM dependencies, so the same code runs in Node via `@napi-rs/canvas`.
3. **Encoder** — frames go one by one into the browser’s H.264 encoder (WebCodecs) and are muxed into
   MP4 with [Mediabunny](https://mediabunny.dev). Nothing is kept in memory, which matters on iOS Safari.
4. **Share** — the Web Share API hands the file to WhatsApp, Telegram or any messenger.

The only network calls are anonymous usage counters (`POST /api/event` → Cloudflare Workers Analytics Engine:
event name, mode, language, text *length*, render time) and Cloudflare Web Analytics. No cookies.

## Development

```bash
npm install
npm run dev          # http://localhost:5173
npm run dev:phone    # HTTPS on your LAN — WebCodecs and Web Share need a secure context
npm test             # timeline/keyboard tests + renderer smoke test in Node
npm run frames -- "Hello there" en normal "1,3,end"   # render frames to out/frames/*.png
npm run og           # regenerate public/og.jpg and the touch icon
```

Requirements for the generated video: iOS 16.4+ Safari or a recent Chrome (WebCodecs with H.264).

## Project layout

| Path | What |
|---|---|
| `src/timeline/` | text → key-press timeline (modes, typos, limits) |
| `src/keyboard/` | iOS-like layouts (en, ru, es, fr) and the keyboard simulator |
| `src/render/` | frame renderer: phone, chat, keyboard, hands, end card |
| `src/encode/` | WebCodecs + Mediabunny MP4 encoder |
| `src/i18n/` | UI and in-video strings |
| `worker/` | Cloudflare Worker that receives analytics events |
| `scripts/` | frame preview, OG image, `npm run stats` funnel report |

## Deploy

Static site + a tiny Worker on Cloudflare (`wrangler.jsonc`). Pushes to `main` deploy the dev environment;
production is deployed manually via the **Deploy production** GitHub Action.

## Contributing

Translation fixes and ideas are very welcome — open an issue or a PR, or write to
[hello@pleasejusttext.me](mailto:hello@pleasejusttext.me).

## License

[MIT](LICENSE)
