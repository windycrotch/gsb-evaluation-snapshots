---
"react-isokit": patch
---

Say why a figure is empty. In development, a `Plate` that cannot be drawn (a negative size, a coordinate that is not finite, or no `fit` and no `viewBox`) now shows a readable `ik-note` in the figure's area — "Figure cannot be drawn" followed by the offending parameter, worded as the schema words it — once per distinct problem, rather than only warning in the console. Production builds are unchanged: no note, no zod, bad data clamped or skipped.

`frame()` also returns its stable `0 0 100 100` fallback when every point it is given is non-finite (never a string containing `NaN`), and falls back to `aspect` 1.25 and `pad` 0.07 when either is invalid. `Box` still returns nothing for a box it cannot draw, but now checks only in development and always names the offending parameter. The `finite` schema now says `x must be a finite number` for `NaN` and `Infinity` instead of `x must be a number`.
