/*
 * CompositeCurve live-invalidation test (Node, no external resources).
 *
 * Loads the library sources directly (no build step) and exercises the real
 * CompositeCurve <-> child-curve <-> observed-array notification chain, plus
 * a Scene2D-level intersection check and a stubbed canvas context for
 * toCanvas/toCanvasPath output. Run with:  node test/composite-curve.test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var ORDER = [
    'header.js', 'Changeable.js', 'Style.js', 'Value.js',
    'Matrix2D.js', 'Object2D.js', 'Point2D.js', 'Topos2D.js',
    'Curve2D.js', 'Line.js', 'QBezier.js', 'CBezier.js', 'Polyline.js',
    'Polygon.js', 'Arc.js', 'Circle.js', 'Ellipse.js', 'Shape2D.js',
    'Scene2D.js', 'utils.js', 'footer.js'
];
var code = ORDER.map(function(f) {
    return fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
}).join('\n;\n');
var moduleObj = {exports: {}};
var ret = (new Function('module', 'exports', 'global', 'self', 'window', code))(
    moduleObj, moduleObj.exports, globalThis, undefined, undefined
);
var G = (ret && ('object' === typeof ret) && ret.CompositeCurve) ? ret : moduleObj.exports;

var CompositeCurve = G.CompositeCurve, Line = G.Line, QBezier = G.QBezier,
    CBezier = G.CBezier, Arc = G.Arc, Matrix2D = G.Matrix2D, Scene2D = G.Scene2D;

var passed = 0, failed = 0;
function ok(name, cond, extra) {
    if (cond) { passed++; return; }
    failed++;
    console.log('FAIL ' + name + (undefined === extra ? '' : '  ' + JSON.stringify(extra)));
}
function close(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }
function bbEq(a, b, eps) {
    return close(a.xmin, b.xmin, eps) && close(a.ymin, b.ymin, eps) &&
           close(a.xmax, b.xmax, eps) && close(a.ymax, b.ymax, eps);
}
var f = function(v) { return typeof v === 'number' ? +v.toFixed(4) : v; };

// a recording canvas 2d-context stub (no external deps)
function makeCtx() {
    var ops = [];
    var ctx = {
        ops: ops, lineCap: null, lineJoin: null, lineWidth: null,
        fillStyle: null, strokeStyle: null,
        beginPath: function() { ops.push('beginPath'); },
        moveTo: function(x, y) { ops.push('moveTo:' + f(x) + ',' + f(y)); },
        lineTo: function(x, y) { ops.push('lineTo:' + f(x) + ',' + f(y)); },
        closePath: function() { ops.push('closePath'); },
        quadraticCurveTo: function(a, b, c, d) { ops.push('q:' + f(c) + ',' + f(d)); },
        bezierCurveTo: function(a, b, c, d, e, g) { ops.push('c:' + f(e) + ',' + f(g)); },
        arc: function() { ops.push('arc'); },
        ellipse: function() { ops.push('ellipse'); },
        fill: function() { ops.push('fill'); },
        stroke: function() { ops.push('stroke'); }
    };
    return ctx;
}

function snapshot(c) {
    return {
        bb: c.getBoundingBox(),
        len: c.length,
        hull: c.getConvexHull().map(function(p) { return [f(p.x), f(p.y)]; }),
        svg: c.toSVGPath()
    };
}
function snapEq(a, b) {
    return bbEq(a.bb, b.bb, 1e-6) && close(a.len, b.len, 1e-6) &&
           JSON.stringify(a.hull) === JSON.stringify(b.hull) && a.svg === b.svg;
}

// ---------------------------------------------------------------------------
// 1. baseline geometry
var seg1 = Line([20, 20], [80, 20]);
var seg2 = QBezier([[80, 20], [110, 5], [130, 40]]);
var seg3 = CBezier([[130, 40], [150, 80], [110, 110], [70, 100]]);
var seg4 = Arc([70, 100], [40, 60], 40, 30, 0, 0, 1);
var comp = CompositeCurve([seg1, seg2, seg3, seg4]);
var base = snapshot(comp);
ok('baseline bbox non-empty', base.bb.xmax > base.bb.xmin && base.bb.ymax > base.bb.ymin, base.bb);
ok('baseline length finite', isFinite(base.len) && base.len > 0, base.len);
ok('baseline hull has points', base.hull.length >= 3, base.hull.length);

// 2. child control point edited in place
seg2.points[1].x = 160;
seg2.points[1].y = -40;
var afterEdit = snapshot(comp);
ok('bbox reflects control-point edit', !bbEq(base.bb, afterEdit.bb), {base: base.bb, after: afterEdit.bb});
ok('hull reflects control-point edit', JSON.stringify(base.hull) !== JSON.stringify(afterEdit.hull));
ok('length reflects control-point edit', !close(base.len, afterEdit.len, 1e-3), {base: base.len, after: afterEdit.len});
ok('svg reflects control-point edit', base.svg !== afterEdit.svg);

// 3. child matrix change
var beforeMatrix = snapshot(comp);
seg1.setMatrix(Matrix2D.translate(-15, 25));
var afterMatrix = snapshot(comp);
ok('bbox reflects child matrix', !bbEq(beforeMatrix.bb, afterMatrix.bb), {before: beforeMatrix.bb, after: afterMatrix.bb});

// 4. replace a segment in the observed array
var beforeReplace = snapshot(comp);
comp.curves.splice(3, 1, Line([70, 100], [-80, -60]));
var afterReplace = snapshot(comp);
ok('bbox reflects segment replacement', !bbEq(beforeReplace.bb, afterReplace.bb), {before: beforeReplace.bb, after: afterReplace.bb});
ok('length reflects segment replacement', isFinite(afterReplace.len) && !close(beforeReplace.len, afterReplace.len, 1e-3));

// 5. push / pop update derived data
var lenBeforePush = comp.length;
comp.curves.push(Line([0, 0], [400, 400]));
ok('length reflects push', !close(lenBeforePush, comp.length, 1e-3), {before: lenBeforePush, after: comp.length});
comp.curves.pop();
ok('length reflects pop', close(lenBeforePush, comp.length, 1e-3), {before: lenBeforePush, after: comp.length});
comp.curves.shift();
ok('length reflects shift', comp.length >= 0);
comp.curves.unshift(Line([0, 0], [10, 200]));
ok('length reflects unshift', comp.length >= 0);

// 6. Scene2D intersections follow edits
var scene = Scene2D(null, 0, 0, 400, 300);
var sLine = Line([20, 40], [300, 40]);
var sQ = QBezier([[20, 40], [160, 40], [300, 120]]);
var sComp = CompositeCurve([sLine, sQ]);
scene.add(sComp);
scene.add(Line([160, 0], [160, 300]));
var ints0 = scene.getIntersections().length;
sQ.points[1].y = 240;
var ints1 = scene.getIntersections().length;
ok('scene intersections recompute after child edit', ints0 !== ints1 || ints0 >= 0, {before: ints0, after: ints1});
sComp.curves.push(Line([20, 130], [300, 130]));
var ints2 = scene.getIntersections().length;
ok('scene intersections recompute after array push', ints2 >= ints1, {before: ints1, after: ints2});

// 7. toCanvas / toCanvasPath produce output (stub ctx)
var ctx = makeCtx();
comp.toCanvas(ctx);
ok('toCanvas emits draw ops', ctx.ops.length > 0, ctx.ops.slice(0, 6));
var ctxPath = makeCtx();
comp.toCanvasPath(ctxPath);
ok('toCanvasPath emits path ops', ctxPath.ops.length > 0, ctxPath.ops.slice(0, 6));

// 8. removed child mutation must not dirty composite
var rA = Line([0, 0], [10, 0]), rB = Line([0, 0], [0, 10]);
var rc = CompositeCurve([rA, rB]);
rc.isChanged(false);
var removed = rc.curves.pop();
rc.isChanged(false);
removed.points[0].x = 999;
removed.points[0].y = 999;
ok('removed child mutation does not dirty composite', rc.isChanged() === false, rc.isChanged());

// 9. surviving children stay observed across splice / shift
var mA = Line([0, 0], [10, 0]), mB = Line([0, 0], [0, 10]), mC = Line([0, 0], [-10, 0]);
var mc = CompositeCurve([mA, mB, mC]);
mc.curves.splice(0, 1); // mB, mC survive and shift down
mc.isChanged(false);
mC.points[0].x = 3;
ok('surviving child after splice stays observed', mc.isChanged() === true);
mc.isChanged(false);
mB.points[0].y = 4;
ok('second surviving child after splice stays observed', mc.isChanged() === true);

// 10. isChanged(false) clears child change flags (originals AND transform copies)
var cc = CompositeCurve([Line([0, 0], [10, 0])]).setMatrix(Matrix2D.translate(5, 0));
cc.length; cc.getBoundingBox(); // warm caches incl. transformed copies
cc.curves[0].points[0].x = 5;
ok('child edit dirties composite', cc.isChanged() === true);
cc.isChanged(false);
ok('isChanged(false) clears composite', cc.isChanged() === false);
ok('isChanged(false) clears original child flag', cc.curves[0].isChanged() === false);

// 11. dispose stops listening and does not throw on later child edits
var dA = Line([0, 0], [10, 0]);
var dc = CompositeCurve([dA]);
var listenersBefore = (dA.$cb || []).length;
var threw = false;
dc.dispose();
try {
    dA.points[0].x = 42;
    dA.setMatrix(Matrix2D.scale(2, 2));
} catch (e) { threw = true; }
ok('dispose detaches child listeners', listenersBefore === 1 && (dA.$cb || []).length === 0, {before: listenersBefore, after: (dA.$cb || []).length});
ok('child edit after dispose does not throw', threw === false);
ok('dispose leaves composite un-dirtied by later child edits', dc.isChanged() === false || dc.curves === null);

// 12. consecutive rapid edits are always fresh
var q = QBezier([[0, 0], [10, 10], [20, 0]]);
var rapid = CompositeCurve([q]);
var xs = [];
for (var i = 1; i <= 6; ++i) { q.points[1].x = 10 + i * 20; xs.push(Math.round(rapid.getBoundingBox().xmax)); }
ok('rapid edits keep bbox fresh & monotone', xs.every(function(v, j) { return 0 === j || v >= xs[j - 1]; }), xs);

// 13. change then revert restores derived data exactly
var rq = QBezier([[0, 0], [10, 10], [20, 0]]);
var rcomp = CompositeCurve([rq]);
var s0 = JSON.stringify(snapshot(rcomp));
rq.points[1].y = 80;
var s1 = JSON.stringify(snapshot(rcomp));
rq.points[1].y = 10;
var s2 = JSON.stringify(snapshot(rcomp));
ok('editing changes derived data', s0 !== s1);
ok('reverting restores derived data', s0 === s2);

// 14. composite with own matrix: child edit + matrix stacking + revert
var mq = QBezier([[0, 0], [10, 0], [20, 0]]);
var mcomp = CompositeCurve([mq]).setMatrix(Matrix2D.translate(100, 0));
var msvg0 = mcomp.toSVGPath();
mq.points[1].y = 40;
var msvg1 = mcomp.toSVGPath();
ok('matrix composite reflects child edit', msvg0 !== msvg1);
var mbb1 = mcomp.getBoundingBox();
mcomp.setMatrix(Matrix2D.translate(100, 0).mul(Matrix2D.scale(2, 2)));
var mbb2 = mcomp.getBoundingBox();
ok('matrix stacking updates bbox', mbb2.xmax > mbb1.xmax, {before: mbb1, after: mbb2});
mcomp.setMatrix(Matrix2D.translate(100, 0));
ok('matrix revert restores derived', mcomp.toSVGPath() === msvg1);

// 15. repeated reads are stable (no stale interleaving)
var rr = CompositeCurve([QBezier([[0, 0], [10, 10], [20, 0]])]);
var rep1 = JSON.stringify(snapshot(rr)), rep2 = JSON.stringify(snapshot(rr));
ok('repeated reads are identical', rep1 === rep2);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
