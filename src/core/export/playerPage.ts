/**
 * The single-file player page: one HTML file that holds the skeleton, its pictures and a small player (the script of `src/player/main.ts`),
 * so it can be mailed to a client and opened offline. The page is made of three parts: a shell (canvas and control bar), the data as a JSON
 * block, and the script. Pure string work; the editor gathers the pictures (`editor/exportPlayer.ts`).
 */
import type { Project } from '../model';

export interface PlayerPayload {
  title: string;
  skeleton: Project['skeleton'];
  /** Picture name -> PNG data URI. */
  images: Record<string, string>;
  /** Smooth textures (false: sharp pixels). */
  smooth: boolean;
}

/** Text that is safe inside an HTML element: `<` and `&` are written as escapes so the browser cannot see a tag or a `</script>` in it. */
const safeJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

const escapeText = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const STYLE = `html,body{height:100%;margin:0;background:#13161c;color:#c7ccd6;font:14px system-ui,sans-serif}
body.light{background:#f2f2f4;color:#30343c}
#stage{position:fixed;inset:0 0 44px 0;width:100%;height:calc(100% - 44px);display:block;touch-action:none;cursor:grab}
#bar{position:fixed;left:0;right:0;bottom:0;height:44px;box-sizing:border-box;display:flex;gap:10px;align-items:center;padding:0 12px;background:rgba(0,0,0,.35)}
body.light #bar{background:rgba(255,255,255,.7)}
#bar button,#bar select{font:inherit;color:inherit;background:rgba(127,127,127,.18);border:1px solid rgba(127,127,127,.35);border-radius:6px;padding:4px 10px}
#bar select{max-width:30vw}
#seek{flex:1;min-width:60px}
#time{font-variant-numeric:tabular-nums;white-space:nowrap}
.error{position:fixed;top:12px;left:12px;color:#ff8a8a}
#over{position:fixed;inset:0 0 44px 0;width:100%;height:calc(100% - 44px);display:block;pointer-events:none}
#dlg{position:fixed;right:12px;bottom:56px;display:block}
#dlg[hidden],#send[hidden]{display:none}
#dlgbox{width:min(360px,92vw);box-sizing:border-box;padding:14px;border-radius:10px;background:#1b1f27;border:1px solid rgba(127,127,127,.35);display:flex;flex-direction:column;gap:8px}
body.light #dlgbox{background:#fff}
#dlgbox input,#dlgbox textarea{font:inherit;color:inherit;background:rgba(127,127,127,.14);border:1px solid rgba(127,127,127,.35);border-radius:6px;padding:6px 8px;box-sizing:border-box;width:100%}
#dlgbox textarea{resize:vertical}
#dlgbox .row{display:flex;gap:8px;justify-content:flex-end}
#dlgbox button{font:inherit;color:inherit;background:rgba(127,127,127,.18);border:1px solid rgba(127,127,127,.35);border-radius:6px;padding:4px 12px}
#dlghead{font-variant-numeric:tabular-nums;opacity:.8}
#bonehint{margin:0;font-size:12px;opacity:.7}
#bonerow{display:flex;gap:6px;align-items:center}
#bonerow[hidden]{display:none}
#mine{margin:0;padding-left:18px;max-height:22vh;overflow:auto;font-size:13px}
#mine li{cursor:pointer;padding:1px 0}
`;

/** The page. `script` is the bundled player (see `virtual:bone2d-player`). */
export function playerPageHtml(payload: PlayerPayload, script: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeText(payload.title)}</title>
<style>${STYLE}</style>
</head><body>
<canvas id="stage"></canvas><canvas id="over"></canvas>
<div id="bar"><button id="play" type="button">Pause</button><input id="seek" type="range" min="0" max="1000" value="0"><span id="time"></span><select id="anim" title="Animation"></select><select id="skin" title="Skin"></select><button id="bg" type="button" title="Light or dark background">Background</button><button id="note" type="button" title="Put a comment on this moment of the animation">Comment</button><button id="send" type="button" hidden title="Download your comments as a file to send to the animator">Send comments</button></div>
<div id="dlg" hidden><div id="dlgbox" role="dialog" aria-label="Comment"><div id="dlghead"></div><p id="bonehint">Click a bone in the picture to point the comment at it</p><div id="bonerow" hidden><span id="bone"></span><button id="bonex" type="button" title="Do not point at a bone">×</button></div><input id="who" type="text" maxlength="60" placeholder="Your name" aria-label="Your name"><textarea id="what" rows="4" maxlength="2000" placeholder="What should change here?" aria-label="Comment"></textarea><ol id="mine"></ol><div class="row"><button id="dcancel" type="button">Close</button><button id="dsave" type="button">Add comment</button></div></div></div>
<script id="b2d-data" type="application/json">${safeJson(payload)}</script>
<script>
// Made with Bone 2D (https://github.com/iamgatz/Bone-2D). Everything this page needs is inside it.
${script.replace(/<\/script/gi, '<\\/script')}
</script>
</body></html>
`;
}

/** The data block of a page, read back (for tests and tools). */
export function readPlayerPayload(html: string): PlayerPayload | null {
  const m = /<script id="b2d-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as PlayerPayload;
  } catch {
    return null;
  }
}
