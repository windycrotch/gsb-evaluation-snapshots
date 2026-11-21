import {
  Bone,
  BoxSelect,
  Brush,
  Crosshair,
  Italic,
  Link2,
  MousePointer2,
  Move,
  PenTool,
  RotateCw,
  Scaling,
  Scissors,
  Triangle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { settingsStore, setSettings } from '@/store/settings';
import type { Tool } from '@/store/ui';

/** The tools of the viewport, in the order of the tool box. The hotkey is one letter; the key handler and the shortcuts window read it from here. */
export const TOOLS: { tool: Tool; icon: LucideIcon; title: string; hotkey: string; setupOnly?: boolean }[] = [
  { tool: 'select', icon: MousePointer2, title: 'Pose / select', hotkey: 'V' },
  { tool: 'create', icon: Bone, title: 'Create bone', hotkey: 'B', setupOnly: true },
  { tool: 'translate', icon: Move, title: 'Translate', hotkey: 'T' },
  { tool: 'rotate', icon: RotateCw, title: 'Rotate', hotkey: 'R' },
  { tool: 'scale', icon: Scaling, title: 'Scale', hotkey: 'S' },
  { tool: 'shear', icon: Italic, title: 'Shear', hotkey: 'H' },
  { tool: 'mesh', icon: Triangle, title: 'Edit mesh / deform', hotkey: 'M' },
  { tool: 'weights', icon: Brush, title: 'Paint weights', hotkey: 'W', setupOnly: true },
  { tool: 'ik', icon: Link2, title: 'IK constraint', hotkey: 'I', setupOnly: true },
  { tool: 'clipping', icon: Scissors, title: 'Clipping polygon', hotkey: 'C', setupOnly: true },
  { tool: 'boundingbox', icon: BoxSelect, title: 'Bounding box', hotkey: 'X', setupOnly: true },
  { tool: 'point', icon: Crosshair, title: 'Point', hotkey: 'P', setupOnly: true },
  { tool: 'path', icon: PenTool, title: 'Path', hotkey: 'N', setupOnly: true },
];

/** The letter of a tool: the one the person chose in Settings, else the default of the table. */
export const hotkeyOf = (tool: Tool): string => settingsStore.get().toolKeys[tool] ?? TOOLS.find((t) => t.tool === tool)!.hotkey;

/** The tool of a typed letter (without Ctrl), if there is one. */
export const toolForKey = (key: string): Tool | undefined => TOOLS.find((t) => hotkeyOf(t.tool).toLowerCase() === key.toLowerCase())?.tool;

/** Gives a tool another letter. Returns the tool that already has the letter (nothing changes then), or null when it is done. */
export function setToolKey(tool: Tool, letter: string): Tool | null {
  const key = letter.toUpperCase();
  const other = TOOLS.find((t) => t.tool !== tool && hotkeyOf(t.tool) === key);
  if (other) return other.tool;
  const keys = { ...settingsStore.get().toolKeys };
  if (key === TOOLS.find((t) => t.tool === tool)!.hotkey) delete keys[tool];
  else keys[tool] = key;
  setSettings({ toolKeys: keys });
  return null;
}

/** What the tool does, shown at the bottom of the viewport while it is active. */
export const HINTS: Record<Tool, string> = {
  select: 'Click a bone or image to select · drag a bone to rotate it · drag an IK target to move it',
  create: 'Drag to create a bone · it attaches to the selected bone · start from a bone tip to chain',
  translate: 'Drag to move the selected bone (or grab an axis) · Shift = add to selection',
  rotate: 'Drag anywhere to rotate the selected bones around their origins',
  scale: 'Drag to scale · Shift = X only · Alt = Y only',
  shear: 'Drag to shear the selected bones: sideways skews the bone, along it skews the other axis · Shift = X only · Alt = Y only',
  mesh: 'Drag vertices · Ctrl-click or double-click adds a vertex · Ctrl-drag between vertices draws an edge · Del removes · in Animate mode dragging keys a deform',
  weights: 'Paint over the mesh · click a bone to switch the brush bone · adjust size and strength in the Inspector',
  ik: 'Drag from the end of a bone chain to a target bone (or empty space to create one)',
  clipping:
    'Click to place polygon points · click the first point, double-click or Enter to finish · Esc cancels · it is created on the selected bone',
  boundingbox:
    'Click to place polygon points · click the first point, double-click or Enter to finish · Esc cancels · it is created on the selected bone',
  point: 'Click to place a point attachment on the selected bone · set its rotation in the Inspector',
  path: 'Click to place a node · drag to pull its handles · click the first node, double-click or Enter to finish · Esc cancels · it is created on the selected bone',
};
