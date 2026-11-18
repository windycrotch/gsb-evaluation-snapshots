/*
	Verification of Expression.SummationLike keyboard navigation against its
	transition tables (P/N/U/D), on a real canvas.

	This harness is READ-ONLY with respect to the transition tables: it never
	writes to Expression.SummationLike.P/N/U/D. It builds summation
	expressions with 2, 3, 4 and 5 children, selects every child, "presses"
	every arrow direction through the exact code path used by
	Formulae.editionArrow (selectedExpression.moveOut(direction)), and checks:

	  1. The new selection is exactly the child dictated by the table, and
	     the selection box (Expression.getRectangle / drawSelecionShape,
	     accumulating x/y along the parent chain) coincides with where the
	     child is actually drawn on the canvas (hit-test + pixel checks).
	  2. Table entries of -1 delegate the movement to the parent expression
	     (Expression.moveOut -> parent.moveAcross). If no ancestor accepts
	     the direction, the selection stays put and no error is raised.
	  3. All of the above for 2, 3, 4 and 5 children.
*/

"use strict";

(function () {

const SIGMA = "Σ";

const DIRECTIONS = [
	{ name: "PREVIOUS (ArrowLeft)", dir: Expression.PREVIOUS, table: Expression.SummationLike.P },
	{ name: "NEXT (ArrowRight)",    dir: Expression.NEXT,     table: Expression.SummationLike.N },
	{ name: "UP (ArrowUp)",         dir: Expression.UP,       table: Expression.SummationLike.U },
	{ name: "DOWN (ArrowDown)",     dir: Expression.DOWN,     table: Expression.SummationLike.D }
];

let total = 0;
let failures = 0;
const lines = [];

function log(s) {
	lines.push(s);
	console.log(s);
}

function check(label, condition, detail) {
	++total;
	if (condition) {
		log("  PASS  " + label);
	}
	else {
		++failures;
		log("  FAIL  " + label + (detail ? "   [" + detail + "]" : ""));
	}
}

function describe(expr) {
	if (expr === null) return "null";
	if (expr === undefined) return "undefined";
	if (!(expr instanceof Expression)) return String(expr);
	let kind =
		expr instanceof Expression.SummationLike ? "SummationLike" :
		expr instanceof Expression.Null ? "Null" : "Expression";
	let index = (expr.parent instanceof Expression) ? expr.index : "-";
	return kind + "#" + expr.id + " (child index " + index + ")";
}

function makeSummation(n) {
	let sum = new Expression.SummationLikeSymbol();
	sum.symbol = SIGMA;
	for (let i = 0; i < n; ++i) sum.addChild(new Expression.Null());
	return sum;
}

function makeHandler(expr, caption) {
	let canvas = document.createElement("canvas");
	let context = canvas.getContext("2d");
	let handler = new ExpressionHandler(expr, context, Formulae.ROW_INPUT);
	handler.prepareDisplay();
	handler.display();

	let figure = document.createElement("figure");
	let figcaption = document.createElement("figcaption");
	figcaption.textContent = caption;
	figure.appendChild(canvas);
	figure.appendChild(figcaption);
	document.getElementById("canvases").appendChild(figure);

	return handler;
}

// Simulates one arrow keypress exactly as Formulae.editionArrow does:
// the movement is requested from the currently selected expression via
// moveOut; the selection changes only if a different expression comes back.
function pressArrow(selectedExpression, direction) {
	let result = selectedExpression.moveOut(direction);
	return (result != null && result != selectedExpression) ? result : selectedExpression;
}

// ---------------------------------------------------------------------------
// geometry checks: the selection box must match the canvas reality
// ---------------------------------------------------------------------------

function verifyGeometry(handler, expr, label, fullPixelChecks) {
	let rect = expr.getRectangle(false);

	// independent re-accumulation of x/y offsets along the parent chain
	let ax = 0, ay = 0, e = expr;
	while (e instanceof Expression) {
		ax += e.x;
		ay += e.y;
		e = e.parent;
	}
	check(
		label + ": getRectangle accumulates x/y along the parent chain",
		rect.x === ax && rect.y === ay && rect.width === expr.width && rect.height === expr.height,
		"getRectangle=(" + rect.x + "," + rect.y + "," + rect.width + "," + rect.height + ") " +
		"accumulated=(" + ax + "," + ay + "," + expr.width + "," + expr.height + ")"
	);

	// hit test: the center of the selection box, asked to the canvas
	// geometry (Expression.fromPoint, same offsets used by display), must
	// resolve back to the very same expression
	let hit = handler.fromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
	check(
		label + ": hit-test at the selection-box center returns the same expression",
		hit === expr,
		"hit=" + describe(hit)
	);

	if (fullPixelChecks) {
		verifySelectionPixels(handler, expr, rect, label);
		if (expr instanceof Expression.Null) verifyLeafBorder(handler, rect, label);
	}
}

// Paints the selection shape exactly the way Formulae.setSelected does
// (globalCompositeOperation "difference", white fill, drawSelecionShape)
// and verifies that the set of modified canvas pixels is precisely the
// accumulated box (shifted by the (1,1) translation of prepareDisplay).
function verifySelectionPixels(handler, expr, rect, label) {
	if (window.devicePixelRatio !== 1) {
		log("  SKIP  " + label + ": pixel test requires devicePixelRatio == 1");
		return;
	}

	let context = handler.context;
	let canvas = context.canvas;

	handler.display(); // clean image
	let before = context.getImageData(0, 0, canvas.width, canvas.height).data;

	let bkpOperation = context.globalCompositeOperation;
	let bkpFillStyle = context.fillStyle;
	context.globalCompositeOperation = "difference";
	context.fillStyle = "white";
	expr.drawSelecionShape(context);
	context.globalCompositeOperation = bkpOperation;
	context.fillStyle = bkpFillStyle;

	let after = context.getImageData(0, 0, canvas.width, canvas.height).data;
	handler.display(); // restore clean image

	let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
	for (let y = 0; y < canvas.height; ++y) {
		for (let x = 0; x < canvas.width; ++x) {
			let o = (y * canvas.width + x) * 4;
			if (before[o] !== after[o] || before[o + 1] !== after[o + 1] || before[o + 2] !== after[o + 2]) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
				++count;
			}
		}
	}

	// prepareDisplay translates the context by (1,1)
	let ok =
		minX === rect.x + 1 && minY === rect.y + 1 &&
		maxX === rect.x + rect.width && maxY === rect.y + rect.height &&
		count === rect.width * rect.height;

	check(
		label + ": selection shape paints exactly the accumulated box on the canvas",
		ok,
		"painted bbox=(" + minX + "," + minY + ")-(" + maxX + "," + maxY + ") count=" + count +
		", expected box=(" + (rect.x + 1) + "," + (rect.y + 1) + ")-(" +
		(rect.x + rect.width) + "," + (rect.y + rect.height) + ") count=" + (rect.width * rect.height)
	);
}

// For a leaf (Expression.Null) the glyph is a rectangle stroked exactly on
// the edges of its box; verify those edge pixels are actually dark on the
// canvas, i.e. the child is *displayed* where the selection box is.
function verifyLeafBorder(handler, rect, label) {
	if (window.devicePixelRatio !== 1) return;

	let context = handler.context;
	handler.display();
	let canvas = context.canvas;
	let data = context.getImageData(0, 0, canvas.width, canvas.height).data;

	let dark = (x, y) => {
		let o = (y * canvas.width + x) * 4;
		return data[o] < 128 && data[o + 1] < 128 && data[o + 2] < 128;
	};

	let x0 = rect.x + 1, y0 = rect.y + 1;                    // device origin of the box
	let x1 = rect.x + rect.width, y1 = rect.y + rect.height; // device far edge (inclusive)
	let mx = x0 + (rect.width >> 1), my = y0 + (rect.height >> 1);

	let points = [
		[ "left",   x0, my ],
		[ "right",  x1, my ],
		[ "top",    mx, y0 ],
		[ "bottom", mx, y1 ]
	];

	let bad = [];
	for (let [ side, x, y ] of points) {
		if (!dark(x, y)) bad.push(side + "@(" + x + "," + y + ")");
	}

	check(
		label + ": leaf glyph is drawn exactly on the selection-box edges",
		bad.length === 0,
		"not dark: " + bad.join(", ")
	);
}

// ---------------------------------------------------------------------------
// navigation checks
// ---------------------------------------------------------------------------

// One (summation, child, direction) navigation, checked against the table.
function verifyNavigation(sum, handler, i, directionDef, labelPrefix) {
	let n = sum.children.length;
	let expected = directionDef.table[n - 2][i];
	let label = labelPrefix + " child " + i + " " + directionDef.name;

	let result = null, error = null;
	try {
		result = sum.children[i].moveOut(directionDef.dir); // same call Formulae.editionArrow makes
	}
	catch (e) {
		error = e;
	}

	check(label + ": no error", error === null, String((error && error.stack) || error));

	if (expected === -1) {
		// -1: the summation delegates to its parent; here the parent is the
		// top-level handler, which declines, so the selection must stay put
		check(
			label + ": table=-1 -> delegated to parent, parent declines -> selection unchanged",
			result === null,
			"result=" + describe(result)
		);
	}
	else {
		check(
			label + ": table=" + expected + " -> selection lands on child " + expected,
			result === sum.children[expected],
			"result=" + describe(result)
		);
		if (result instanceof Expression) {
			let rect = result.getRectangle(false);
			log("    new selection: child " + result.index +
				", selection box (x=" + rect.x + ", y=" + rect.y +
				", w=" + rect.width + ", h=" + rect.height + ")");
			verifyGeometry(handler, result, label + " [new selection]", false);
		}
	}
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

try {
	log("Transition tables (read-only; navigation is verified against them):");
	for (let d of DIRECTIONS) {
		for (let r = 0; r < d.table.length; ++r) {
			log("  " + d.name + " n=" + (r + 2) + ": [" + d.table[r].join(", ") + "]");
		}
	}

	// ------------------------------------------------------------------
	// exhaustive: 2, 3, 4 and 5 children x every child x every direction
	// ------------------------------------------------------------------

	for (let n = 2; n <= 5; ++n) {
		let sum = makeSummation(n);
		let handler = makeHandler(sum, SIGMA + " with " + n + " children");

		log("");
		log("=== summation with " + n + " children ===");

		for (let i = 0; i < n; ++i) {
			verifyGeometry(handler, sum.children[i], "n=" + n + " child " + i, true);
		}

		for (let i = 0; i < n; ++i) {
			for (let d of DIRECTIONS) {
				verifyNavigation(sum, handler, i, d, "n=" + n);
			}
		}
	}

	// ------------------------------------------------------------------
	// delegation: -1 hands the movement to the parent expression
	// ------------------------------------------------------------------

	log("");
	log("=== delegation to the parent expression (nested summations) ===");
	{
		// outer Σ with 3 children: [ leaf, inner Σ with 2 children, leaf ]
		let outer = makeSummation(0);
		outer.addChild(new Expression.Null());
		let inner = makeSummation(2);
		outer.addChild(inner);
		outer.addChild(new Expression.Null());

		let handler = makeHandler(outer, "nested " + SIGMA + " (inner " + SIGMA + " is child 1)");

		// geometry through a two-level parent chain
		verifyGeometry(handler, inner.children[0], "nested inner child 0", true);
		verifyGeometry(handler, inner.children[1], "nested inner child 1", true);

		// inner is n=2, so every U/D entry of its row is -1: the keypress
		// must be handled by the OUTER summation's tables (row n=3)
		let result, error;

		error = null;
		try { result = inner.children[0].moveOut(Expression.UP); } catch (e) { error = e; }
		check("nested: inner child 0 UP: no error", error === null, String(error));
		check(
			"nested: inner child 0 UP: inner table=-1 -> outer table U[n=3][1]=2 -> outer child 2 selected",
			result === outer.children[2],
			"result=" + describe(result)
		);
		if (result instanceof Expression) verifyGeometry(handler, result, "nested: inner child 0 UP [new selection]", false);

		error = null;
		try { result = inner.children[0].moveOut(Expression.NEXT); } catch (e) { error = e; }
		check("nested: inner child 0 NEXT: no error", error === null, String(error));
		check(
			"nested: inner child 0 NEXT: inner table=-1 -> outer table N[n=3][1]=0 -> outer child 0 selected",
			result === outer.children[0],
			"result=" + describe(result)
		);

		error = null;
		try { result = inner.children[1].moveOut(Expression.DOWN); } catch (e) { error = e; }
		check("nested: inner child 1 DOWN: no error", error === null, String(error));
		check(
			"nested: inner child 1 DOWN: inner table=-1, outer table D[n=3][1]=-1, top-level declines -> selection unchanged",
			result === null,
			"result=" + describe(result)
		);

		error = null;
		try { result = inner.children[0].moveOut(Expression.PREVIOUS); } catch (e) { error = e; }
		check("nested: inner child 0 PREVIOUS: no error", error === null, String(error));
		check(
			"nested: inner child 0 PREVIOUS: inner table P[n=2][0]=1 -> inner child 1 selected (no delegation)",
			result === inner.children[1],
			"result=" + describe(result)
		);
	}

	// ------------------------------------------------------------------
	// acceptance paths called out in the requirements
	// ------------------------------------------------------------------

	log("");
	log("=== acceptance paths ===");
	{
		// n=4, NEXT row is N[2] = [-1, 2, 0, 0, -1]: pressing NEXT on the
		// middle children wraps to child 0 (N[2][2] = 0, N[2][3] = 0),
		// while N[2][1] = 2.
		let sum4 = makeSummation(4);
		let handler4 = makeHandler(sum4, SIGMA + " with 4 children (acceptance)");
		let sel = pressArrow(sum4.children[2], Expression.NEXT);
		check(
			"acceptance: n=4, NEXT from child index 2 -> child index 0 (N[2][2]=0)",
			sel === sum4.children[0],
			"selected=" + describe(sel)
		);
		sel = pressArrow(sum4.children[3], Expression.NEXT);
		check(
			"acceptance: n=4, NEXT from child index 3 -> child index 0 (N[2][3]=0)",
			sel === sum4.children[0],
			"selected=" + describe(sel)
		);
		sel = pressArrow(sum4.children[1], Expression.NEXT);
		check(
			"acceptance: n=4, NEXT from child index 1 -> child index 2 (N[2][1]=2)",
			sel === sum4.children[2],
			"selected=" + describe(sel)
		);

		// n=5, NEXT from the 4th child (index 3) goes to the 5th (index 4)
		let sum5 = makeSummation(5);
		makeHandler(sum5, SIGMA + " with 5 children (acceptance)");
		sel = pressArrow(sum5.children[3], Expression.NEXT);
		check(
			"acceptance: n=5, NEXT from child index 3 (4th child) -> child index 4 (5th child) (N[3][3]=4)",
			sel === sum5.children[4],
			"selected=" + describe(sel)
		);

		// n=2, DOWN has no target (D[0] is all -1): delegated to the parent;
		// the top-level parent declines, so the selection stays put
		let sum2 = makeSummation(2);
		makeHandler(sum2, SIGMA + " with 2 children (acceptance)");
		for (let i = 0; i < 2; ++i) {
			let before = sum2.children[i];
			let after = pressArrow(before, Expression.DOWN);
			check(
				"acceptance: n=2, DOWN from child " + i + ": no available child -> out to parent, selection unchanged",
				after === before,
				"selected=" + describe(after)
			);
		}
	}
}
catch (e) {
	++failures;
	log("FATAL: harness aborted with " + ((e && e.stack) || e));
}

log("");
log(failures === 0 ?
	"RESULT: PASS — " + total + " checks, 0 failures" :
	"RESULT: FAIL — " + failures + " of " + total + " checks failed");

let pre = document.createElement("pre");
pre.id = "log";
pre.textContent = lines.join("\n");
document.body.appendChild(pre);

let summary = document.getElementById("summary");
summary.textContent = lines[lines.length - 1];
summary.className = failures === 0 ? "pass" : "fail";
document.title = summary.textContent;

window.__testResults = { total: total, failures: failures };

})();
