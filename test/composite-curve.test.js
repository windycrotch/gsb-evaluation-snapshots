/**
 * CompositeCurve consistency test-suite
 *
 * Run with:
 *   node test/composite-curve.test.js
 *
 * The suite builds the library from src/*.js in-memory (same order as
 * beeld.config), so it always exercises the current sources and needs no
 * pre-built ./build/Geometrize.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
// order mirrors the "src" list in beeld.config
const SOURCES = [
    'header.js', 'Changeable.js', 'Style.js', 'Value.js', 'Matrix2D.js',
    'Object2D.js', 'Point2D.js', 'Topos2D.js', 'Curve2D.js', 'Line.js',
    'QBezier.js', 'CBezier.js', 'Polyline.js', 'Polygon.js', 'Arc.js',
    'Circle.js', 'Ellipse.js', 'Shape2D.js', 'Scene2D.js', 'utils.js',
    'footer.js'
];

function load() {
    // run as a CommonJS module so the UMD header exports `Geometrize`
    const code = SOURCES.map(f => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')).join('\n');
    const mod = {exports: {}};
    const fn = vm.runInThisContext('(function (module, exports, require) {' + code + '\n})',
        {filename: 'Geometrize.bundle.js'});
    fn(mod, mod.exports, require);
    return mod.exports;
}

const G = load();
const {CompositeCurve, Line, QBezier, Arc, Point2D, Matrix2D, Scene2D} = G;

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; }
    else { fail++; console.log('  FAIL  ' + msg); }
}
function eq(a, b, msg) { ok(a === b, msg + ' (got ' + a + ', want ' + b + ')'); }
function near(a, b, msg) { ok(Math.abs(a - b) < 1e-6, msg + ' (got ' + a + ', want ' + b + ')'); }
function pts(c) { return c.points.map(p => [p.x, p.y]); }
function hullPts(c) { return c.getConvexHull().map(p => [p.x, p.y]); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ---------------------------------------------------------------- 1
section('1. in-place child edits invalidate derived data');
(function () {
    const l1 = Line([0, 0], [10, 0]);
    const q = QBezier([[10, 0], [20, 10], [30, 0]]);
    const arc = Arc([30, 0], [40, 0], 5, 5, 0, 0, 1);
    const cc = CompositeCurve([l1, q, arc]);

    // warm every cache
    JSON.stringify(pts(cc)); JSON.stringify(cc.getBoundingBox());
    JSON.stringify(hullPts(cc)); cc.length; cc._curves;
    near(cc.getBoundingBox().xmax, 40, 'baseline bbox.xmax');
    cc.isChanged(false);

    l1.end.x = 100; l1.end.y = 50;
    eq(cc.isChanged(), true, 'line edit marks composite changed');
    ok(JSON.stringify(pts(cc)).indexOf('[100,50]') >= 0, 'points reflect line edit');
    near(cc.getBoundingBox().xmax, 100, 'bbox.xmax reflects line edit');
    near(cc.getBoundingBox().ymax, 50, 'bbox.ymax reflects line edit');
    ok(cc.length > 138, 'length reflects line edit');
    ok(JSON.stringify(hullPts(cc)).indexOf('[100,50]') >= 0, 'hull reflects line edit');
    eq(cc._curves.length, 3, '_curves rebuilt with the same count');
    near(cc._curves[0].points[1].x, 100, '_curves reflect line edit x');
    near(cc._curves[0].points[1].y, 50, '_curves reflect line edit y');

    cc.isChanged(false);
    q.points[1].y = 50;
    eq(cc.isChanged(), true, 'control point edit marks composite changed');
    ok(JSON.stringify(pts(cc)).indexOf('[20,50]') >= 0, 'points reflect control point edit');
    near(cc.getBoundingBox().ymax, 50, 'bbox.ymax reflects control point edit');
    ok(cc.getConvexHull().some(p => Math.abs(p.y - 50) < 1e-6), 'hull reflects control point edit');

    cc.isChanged(false);
    const lenBefore = cc.length, bbBefore = JSON.stringify(cc.getBoundingBox());
    arc.radiusX = 20;
    eq(cc.isChanged(), true, 'arc radius edit marks composite changed');
    ok(cc.length !== lenBefore, 'length changes after arc radius edit');
    ok(JSON.stringify(cc.getBoundingBox()) !== bbBefore, 'bbox changes after arc radius edit');
    eq(cc._curves.length, 3, '_curves still has three children');

    // replacing a control point object inside a child
    const q2 = QBezier([[0, 0], [1, 1], [2, 0]]);
    const cc2 = CompositeCurve([q2]);
    cc2.points; cc2.getBoundingBox(); cc2.length; cc2.getConvexHull();
    cc2.isChanged(false);
    q2.points[1] = Point2D(1, 9);
    eq(cc2.isChanged(), true, 'replaced control point marks composite changed');
    ok(JSON.stringify(pts(cc2)).indexOf('[1,9]') >= 0, 'points reflect replaced control point');
    near(cc2.getBoundingBox().ymax, 4.5, 'bbox reflects replaced control point');
})();

// ---------------------------------------------------------------- 2
section('2. array add/remove rewires listeners');
(function () {
    const l1 = Line([0, 0], [10, 0]);
    const l2 = Line([10, 0], [10, 10]);
    const cc = CompositeCurve([l1, l2]);
    cc.points; cc.getBoundingBox(); cc.length; cc.getConvexHull();
    cc.isChanged(false);

    const l3 = Line([50, 50], [60, 50]);
    cc.curves.push(l3);
    eq(cc.curves.length, 3, 'push appends');
    eq(cc.isChanged(), true, 'push invalidates');
    near(cc.length, 30, 'length includes pushed curve');
    ok(JSON.stringify(pts(cc)).indexOf('[50,50]') >= 0, 'points include pushed curve');
    eq(l3.$cb ? l3.$cb.length : 0, 1, 'pushed curve has one listener');
    eq(l3.$cb[0], cc._onCurveChange, 'pushed curve listener is the composite callback');
    cc.isChanged(false);
    l3.end.x = 70;
    eq(cc.isChanged(), true, 'pushed curve change invalidates');
    near(cc.length, 40, 'length tracks pushed curve mutation');

    cc.isChanged(false);
    cc.curves.splice(0, 1);
    eq(cc.curves.length, 2, 'splice removes');
    eq(cc.isChanged(), true, 'splice invalidates');
    eq(l1.$cb ? l1.$cb.length : 0, 0, 'removed curve detached');
    near(cc.length, 30, 'length drops removed curve');
    cc.isChanged(false);
    l1.end.x = 999;
    eq(cc.isChanged(), false, 'removed curve no longer invalidates');
    eq(cc.curves.indexOf(l1), -1, 'removed curve gone from array');
    l2.end.x = 40;
    eq(cc.isChanged(), true, 'remaining curve still invalidates');

    cc.isChanged(false);
    const l4 = Line([-10, -10], [-5, -10]);
    cc.curves.unshift(l4);
    eq(cc.curves[0], l4, 'unshift puts curve first');
    eq(l4.$cb ? l4.$cb.length : 0, 1, 'unshifted curve observed');
    eq(cc.isChanged(), true, 'unshift invalidates');
    cc.isChanged(false);
    l4.end.y = -30;
    eq(cc.isChanged(), true, 'unshifted curve change invalidates');

    cc.isChanged(false);
    const popped = cc.curves.pop();
    eq(popped.$cb ? popped.$cb.length : 0, 0, 'popped curve detached');
    eq(cc.isChanged(), true, 'pop invalidates');

    cc.isChanged(false);
    const shifted = cc.curves.shift();
    eq(shifted.$cb ? shifted.$cb.length : 0, 0, 'shifted curve detached');

    // notifications must resume after shift
    const a = Line([0, 0], [1, 0]), b = Line([1, 0], [2, 0]), c = Line([2, 0], [3, 0]);
    const cc4 = CompositeCurve([a, b, c]);
    cc4.curves.shift();
    eq(cc4.curves[0], b, 'shift keeps the right remainder');
    eq(b.$cb ? b.$cb.length : 0, 1, 'item after shift observed');
    cc4.isChanged(false);
    b.end.x = 42;
    eq(cc4.isChanged(), true, 'item after shift notifies');

    // splice insert in the middle
    const mid = Line([1, 1], [2, 2]);
    cc.curves.splice(1, 0, mid);
    eq(cc.curves[1], mid, 'splice insert lands at index');
    eq(mid.$cb ? mid.$cb.length : 0, 1, 'splice-inserted curve observed');

    // splice replacing several items (fresh curves, not shared with other composites)
    const mx = Line([10, 10], [11, 10]), my = Line([11, 10], [12, 10]);
    const mr1 = Line([4, 0], [5, 0]), mr2 = Line([5, 0], [6, 0]);
    const cc5 = CompositeCurve([Line([0, 0], [1, 0]), mr1, mr2]);
    cc5.curves.splice(1, 2, mx, my);
    eq(cc5.curves.length, 3, 'splice replace count');
    ok(cc5.curves[1] === mx && cc5.curves[2] === my, 'splice replace contents');
    eq(mr1.$cb ? mr1.$cb.length : 0, 0, 'splice-replaced first curve detached');
    eq(mr2.$cb ? mr2.$cb.length : 0, 0, 'splice-replaced second curve detached');
    eq(mx.$cb.length, 1, 'splice-inserted x observed');
    eq(my.$cb.length, 1, 'splice-inserted y observed');

    // direct index replacement
    cc.isChanged(false);
    const oldAt0 = cc.curves[0];
    const replacement = Line([3, 3], [4, 4]);
    cc.curves[0] = replacement;
    eq(cc.curves[0], replacement, 'index assignment replaces');
    eq(oldAt0.$cb ? oldAt0.$cb.length : 0, 0, 'replaced curve detached');
    eq(replacement.$cb ? replacement.$cb.length : 0, 1, 'replacement observed');
    eq(cc.isChanged(), true, 'index replacement invalidates');
    cc.isChanged(false);
    replacement.end.x = 30;
    eq(cc.isChanged(), true, 'index-assigned curve notifies');
    cc.isChanged(false);
    oldAt0.end.x = 800;
    eq(cc.isChanged(), false, 'replaced-away curve does not notify');

    // replacing the whole curves array
    const a2 = Line([0, 0], [1, 0]), b2 = Line([2, 0], [3, 0]);
    const cc6 = CompositeCurve([a2]);
    // force the points cache to be computed before the array is replaced
    ok(JSON.stringify(pts(cc6)) === JSON.stringify([[0, 0], [1, 0]]), 'points before array replace');
    cc6.curves = [b2];
    eq(a2.$cb ? a2.$cb.length : 0, 0, 'old array item detached on array replace');
    eq(b2.$cb.length, 1, 'new array item observed on array replace');
    cc6.isChanged(false);
    b2.end.x = 9;
    eq(cc6.isChanged(), true, 'new array item notifies');
    ok(pts(cc6).some(p => Math.abs(p[0] - 9) < 1e-9), 'points reflect new array item');
})();

// ---------------------------------------------------------------- 3
section('3. isChanged propagation direction');
(function () {
    const l1 = Line([0, 0], [10, 0]);
    const l2 = Line([10, 0], [10, 10]);
    const cc = CompositeCurve([l1, l2]);
    cc.points; cc.getBoundingBox(); cc.length; cc.getConvexHull(); cc._curves;
    cc.isChanged(false);

    l1.end.x = 5;
    ok(cc.isChanged() === true && l1.isChanged() === true, 'both dirty before reset');
    cc.isChanged(false);
    eq(cc.isChanged(), false, 'composite clean after reset');
    eq(l1.isChanged(), false, 'child clean after composite reset');
    eq(l2.isChanged(), false, 'second child clean after composite reset');

    l1.end.x = 8;
    eq(l1.isChanged(), true, 'child dirty after edit');
    eq(cc.isChanged(), true, 'composite inherits child dirtiness');

    cc.isChanged(false);
    const before = cc.length;
    cc.isChanged(true);
    eq(cc.isChanged(), true, 'composite dirty after isChanged(true)');
    eq(l1.isChanged(), false, 'isChanged(true) does not dirty children');
    eq(cc.length, before, 'length numerically unchanged after invalidation');
    ok(JSON.stringify(pts(cc)).indexOf('[8,0]') >= 0, 'points recomputed after invalidation');

    cc.isChanged(false);
    l1.end.y = 7;
    cc.isChanged(false);
    eq(cc.isChanged(), false, 'composite clean after second reset');
    ok(JSON.stringify(pts(cc)).indexOf('[8,7]') >= 0, 'points consistent with reset child');

    // nested composites
    const inner = CompositeCurve([Line([0, 0], [1, 0])]);
    const outer = CompositeCurve([inner, Line([1, 0], [2, 0])]);
    outer.points; outer.getBoundingBox();
    outer.isChanged(false);
    inner.curves[0].end.x = 100;
    eq(inner.isChanged(), true, 'inner composite dirty from its child');
    eq(outer.isChanged(), true, 'outer composite dirty from inner composite');
    near(outer.getBoundingBox().xmax, 100, 'outer bbox sees grandchild edit');
})();

// ---------------------------------------------------------------- 4
section('4. transform and matrix behaviour');
(function () {
    const l1 = Line([0, 0], [10, 0]);
    const cc = CompositeCurve([l1]).setMatrix(Matrix2D.translate(5, 5));
    near(cc._curves[0].points[0].x, 5, '_curves apply the matrix');
    near(cc._curves[0].points[1].x, 15, '_curves apply the matrix to endpoint');
    near(cc.getBoundingBox().xmin, 5, 'bbox includes matrix translation');
    near(cc.length, 10, 'length is unchanged by a rigid translation');
    cc.isChanged(false);

    l1.end.x = 30;
    eq(cc.isChanged(), true, 'child edit invalidates matrix composite');
    near(cc._curves[0].points[1].x, 35, '_curves recomputed with matrix after child edit');
    near(cc.getBoundingBox().xmax, 35, 'bbox recomputed with matrix after child edit');

    cc.isChanged(false);
    cc.setMatrix(Matrix2D.translate(20, 0));
    eq(cc.isChanged(), true, 'matrix change invalidates');
    near(cc._curves[0].points[0].x, 20, '_curves reflect new matrix');

    // array mutations keep the matrix applied
    const cc3 = CompositeCurve([Line([0, 0], [1, 0])]).setMatrix(Matrix2D.translate(10, 0));
    cc3.getBoundingBox(); cc3.length; cc3.getConvexHull(); cc3._curves;
    cc3.curves.push(Line([5, 0], [6, 0]));
    near(cc3.getBoundingBox().xmax, 16, 'matrix bbox after push');
    near(cc3.length, 2, 'matrix length after push');
    cc3.curves.splice(0, 1);
    near(cc3.length, 1, 'matrix length after splice');

    // transform() yields an independent composite
    const src = CompositeCurve([Line([0, 0], [10, 0]), Line([10, 0], [10, 5])]);
    const moved = src.transform(Matrix2D.translate(100, 0));
    eq(moved.curves.length, 2, 'transform keeps the curve count');
    near(moved.getBoundingBox().xmin, 100, 'transform applies the matrix');
    src.curves[0].end.x = 500;
    near(moved.curves[0].end.x, 110, 'transformed copy is independent of the source');
})();

// ---------------------------------------------------------------- 5
section('5. dispose releases listeners safely');
(function () {
    const l1 = Line([0, 0], [10, 0]);
    const l2 = Line([10, 0], [10, 10]);
    const cc = CompositeCurve([l1, l2]);
    eq(l1.$cb ? l1.$cb.length : 0, 1, 'child observed before dispose');
    eq(l2.$cb ? l2.$cb.length : 0, 1, 'second child observed before dispose');

    cc.dispose();
    eq(l1.$cb ? l1.$cb.length : 0, 0, 'child released by dispose');
    eq(l2.$cb ? l2.$cb.length : 0, 0, 'second child released by dispose');
    eq(cc.curves, null, 'curves null after dispose');

    let threw = false;
    try { l1.end.x = 77; l2.points[1].y = 88; l1.style.stroke = 'red'; }
    catch (e) { threw = true; }
    ok(!threw, 'child changes after dispose do not throw');

    threw = false;
    try { cc.points; cc.getBoundingBox(); cc.getConvexHull(); cc.length; cc._curves; }
    catch (e) { threw = true; }
    ok(!threw, 'derived reads after dispose do not throw');
    eq(cc.curves, null, 'curves stay null after derived reads');

    threw = false;
    try { cc.isChanged(false); } catch (e) { threw = true; }
    ok(!threw, 'isChanged(false) after dispose does not throw');

    threw = false;
    try { cc.dispose(); } catch (e) { threw = true; }
    ok(!threw, 'dispose is idempotent');

    // shared child: disposing one composite must not unhook the other
    const shared = Line([0, 0], [1, 1]);
    const a = CompositeCurve([shared]);
    const b = CompositeCurve([shared]);
    eq(shared.$cb.length, 2, 'shared child has two listeners');
    a.dispose();
    eq(shared.$cb.length, 1, 'only one listener removed by disposing one composite');
    eq(shared.$cb[0], b._onCurveChange, 'remaining listener belongs to the survivor');
    b.isChanged(false);
    shared.end.x = 9;
    eq(b.isChanged(), true, 'surviving composite still notified');
    near(b.getBoundingBox().xmax, 9, 'surviving composite geometry updates');
    b.dispose();
    eq(shared.$cb ? shared.$cb.length : 0, 0, 'last listener removed');
})();

// ---------------------------------------------------------------- 6
section('6. public API and serialisation unchanged');
(function () {
    const cc = CompositeCurve([Line([0, 0], [10, 0]), Line([10, 0], [10, 10])]);
    eq(typeof cc.toSVGPath(), 'string', 'toSVGPath returns a string');
    eq(cc.toSVG(false).indexOf('<path ') === 0, true, 'toSVG(false) renders a path');
    eq(cc.clone().curves.length, 2, 'clone keeps the curve count');
    eq(cc.toString().indexOf('CompositeCurve(') === 0, true, 'toString prefix');
    eq(cc.toTex().indexOf(String.fromCharCode(92) + 'text{CompositeCurve: }') === 0, true, 'toTex prefix');
    ok(Array.isArray(cc.polylinePoints()), 'polylinePoints returns an array');
    ok(Array.isArray(cc.bezierPoints()), 'bezierPoints returns an array');
    eq(cc.area, 0, 'area is 0');
    eq(cc.name, 'CompositeCurve', 'name is CompositeCurve');

    // connected curves merge M commands, disconnected ones keep them
    const conn = CompositeCurve([Line([0, 0], [10, 0]), Line([10, 0], [10, 10])]);
    eq(conn.toSVGPath(), 'M 0 0 L 10 0 L 10 10', 'connected path merges the M command');
    const disc = CompositeCurve([Line([0, 0], [10, 0]), Line([50, 50], [60, 60])]);
    eq(disc.toSVGPath(), 'M 0 0 L 10 0 M 50 50 L 60 60', 'disconnected path keeps M commands');

    const calls = [];
    const ctx = new Proxy({}, {get: function (t, k) {
        if (k === 'moveTo' || k === 'lineTo' || k === 'beginPath' || k === 'closePath' ||
            k === 'quadraticCurveTo' || k === 'bezierCurveTo' || k === 'arc') {
            return function () { calls.push(k); };
        }
        return function () {};
    }, set: function () { return true; }});
    let threw = false;
    try { cc.toCanvasPath(ctx); } catch (e) { threw = true; }
    ok(!threw, 'toCanvasPath works');
    ok(calls.indexOf('beginPath') >= 0, 'toCanvasPath issued drawing calls');

    const scene = Scene2D(null, 0, 0, 100, 100);
    scene.add(cc);
    scene.add(Line([0, 10], [10, 5]));
    ok(Array.isArray(scene.getIntersections()), 'Scene2D works with a composite');
})();

// ---------------------------------------------------------------- 7
section('7. boundary paths');
(function () {
    const empty = CompositeCurve([]);
    eq(empty.curves.length, 0, 'empty curves array');
    ok(Array.isArray(empty.points) && empty.points.length === 0, 'empty points array');
    eq(empty.length, 0, 'empty length');
    eq(empty.getBoundingBox().xmin, Infinity, 'empty bbox is the neutral box');
    ok(Array.isArray(empty.getConvexHull()), 'empty hull is an array');
    eq(empty.isConnected(), false, 'empty not connected');
    eq(empty.isClosed(), false, 'empty not closed');
    ok(Array.isArray(empty._curves), 'empty _curves array');

    const single = CompositeCurve([Line([0, 0], [10, 0])]);
    eq(single.isConnected(), true, 'single-line composite is connected');
    near(single.length, 10, 'single-line length');

    const cc = CompositeCurve([Line([0, 0], [1, 0])]);
    cc.points; cc.length; cc.getBoundingBox();
    cc.curves = null;
    eq(cc.curves, null, 'curves can be set to null');
    eq(cc.points.length, 0, 'points empty after curves=null');
    eq(cc.length, 0, 'length 0 after curves=null');

    const cc2 = CompositeCurve([Line([0, 0], [1, 0])]);
    let threw = false;
    try { cc2.curves.push({x: 1}); } catch (e) { threw = true; }
    eq(threw, false, 'pushing a non-curve is tolerated');

    // duplicates: one shared listener, removed only when the last occurrence goes
    const dup = Line([0, 0], [1, 0]);
    const cc3 = CompositeCurve([dup, dup]);
    eq(dup.$cb.length, 1, 'duplicate insert registers one listener');
    cc3.curves.splice(0, 1);
    eq(cc3.curves.length, 1, 'one duplicate removed');
    eq(dup.$cb.length, 1, 'remaining duplicate keeps the listener');
    cc3.isChanged(false);
    dup.end.x = 50;
    eq(cc3.isChanged(), true, 'remaining duplicate notifies');

    cc3.curves.splice(0, cc3.curves.length);
    threw = false;
    try { cc3.dispose(); } catch (e) { threw = true; }
    ok(!threw, 'dispose after emptying does not throw');
    eq(dup.$cb ? dup.$cb.length : 0, 0, 'no listener remains');
})();

// ---------------------------------------------------------------- summary
console.log('\n----------------------------------------');
console.log('PASS: ' + pass + '   FAIL: ' + fail);
process.exit(fail ? 1 : 0);
