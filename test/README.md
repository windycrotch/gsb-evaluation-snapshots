# SummationLike navigation verification

`summation-navigation.html` verifies, on a real canvas, that keyboard
navigation inside `Expression.SummationLike` (Σ-like expressions with 2–5
children) follows the transition tables `Expression.SummationLike.P/N/U/D`
in `formulae/expression.js`. The tables are only read, never modified.

For every child count n ∈ {2, 3, 4, 5}, every child index and every arrow
direction, the harness:

- presses the key through the exact path `Formulae.editionArrow` uses
  (`selectedExpression.moveOut(direction)` → `parent.moveAcross(index, direction)`);
- checks the new selection is the child dictated by the table, and that a
  table value of `-1` delegates to the parent expression (top-level parent
  declines → selection unchanged, no error);
- checks the selection box (`getRectangle` / `drawSelecionShape`, x/y
  accumulated along the parent chain) against the canvas reality:
  hit-testing (`fromPoint`) at the box center returns the same expression,
  the selection shape painted exactly as `Formulae.setSelected` paints it
  covers exactly the accumulated box, and leaf glyphs are drawn on the box
  edges.

A nested-summation case verifies that `-1` hands the movement to the parent
expression's own tables (and that the selection stays put, without errors,
when no ancestor accepts the direction).

## Running

Open `test/summation-navigation.html` in a browser, or headless:

```sh
chrome --headless=new --dump-dom "file:///path/to/repo/test/summation-navigation.html" | grep "RESULT:"
```

Expected output: `RESULT: PASS — 244 checks, 0 failures`.
