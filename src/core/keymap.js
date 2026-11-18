import { KEY } from './layout.js';

// Physical key codes so the mapping survives non-QWERTY layouts.
// Row 0 is the top row on screen and the highest pitches.
const ROWS = [
  ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'],
  ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
  ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'],
];

const GLYPHS = { Semicolon: ';', Comma: ',', Period: '.', Slash: '/' };

function glyphFor(code) {
  return GLYPHS[code] ?? code.replace('Key', '');
}

export const PADS = [];
export const BY_CODE = new Map();

for (let row = 0; row < ROWS.length; row++) {
  for (let col = 0; col < ROWS[row].length; col++) {
    const code = ROWS[row][col];
    const pad = {
      index: PADS.length,
      row,
      col,
      code,
      glyph: glyphFor(code),
      // Bottom row holds the lowest degrees.
      degree: (KEY.rows - 1 - row) * KEY.cols + col,
    };
    PADS.push(pad);
    BY_CODE.set(code, pad);
  }
}

export const PAD_COUNT = PADS.length;

export function padForCode(code) {
  return BY_CODE.get(code) ?? null;
}

export function padAt(row, col) {
  return PADS[row * KEY.cols + col] ?? null;
}
