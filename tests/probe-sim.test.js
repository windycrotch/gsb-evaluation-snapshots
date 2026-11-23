#!/usr/bin/env node
/**
 * Stock-simulation probing tests.
 *
 * Loads the browser sources in a VM (they are plain globals, no imports) and checks that
 * a simulated G38.x probe, the carved stock surface and the probe's event text all agree,
 * across the acceptance cases in tests/fixtures. Run with:  node tests/probe-sim.test.js
 *
 * The checks:
 *  - A probe that touches (no P) ends exactly on the drawn surface height at its XY.
 *  - A probe with P ends with its tip on the plate top (surfaceTop + P), and the work
 *    offset is set so the contact reads P.
 *  - The event text's Z equals the contact height in the coordinate system in force, so
 *    text, tip and surface agree.
 *  - A straight-down probe sees every earlier cutting move, arcs (tessellated) included.
 *  - A failed G38.2 raises one alarm, adds no contact point, and leaves the surface and
 *    offsets unchanged: the next probe at the same place touches the same height.
 *  - A G20/G21 switch keeps the physical position: the surface, the probe start and the
 *    contact height stay put, and no move is double- or un-scaled.
 *  - Parsing the same file twice gives identical segments and events.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repo = path.resolve(__dirname, '..');

function loadModules() {
    const ctx = { console, performance: { now: () => Number(process.hrtime.bigint()) / 1e6 } };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    let src = '';
    for (const name of ['gcode-expander.js', 'stock-sim.js', 'parser.js']) {
        src += fs.readFileSync(path.join(repo, 'src/js', name), 'utf8') + '\n;\n';
    }
    src += 'globalThis.__exports = { StockSimulator, StockProbe, stockSimCells, GCodeParser };\n';
    vm.runInContext(src, ctx, { filename: 'bundle.js' });
    return ctx.__exports;
}

const X = loadModules();
const EPS = 1e-3; // mm: float32 heights and the interpolated mesh

let failures = 0;
let passes = 0;
function ok(name, cond, detail = '') {
    if (cond) {
        passes++;
    } else {
        failures++;
        console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`);
    }
}
function eq(name, a, b, tol = EPS) {
    ok(name, Math.abs(a - b) <= tol, `${a} vs ${b}`);
}

/**
 * Rebuild the drawn surface the 3D view shows for `parser`: carve a dense StockSimulator
 * on the same grid the probe model uses, then interpolate its heights across the same
 * triangles the mesh renderer draws. This is computed here independently of the probe
 * model, so the checks prove the probe meets the visible surface, not just itself.
 */
function displaySurfaceAt(sim, x, y) {
    const S = sim.stock;
    if (!(x >= S.xmin && x <= S.xmax && y >= S.ymin && y <= S.ymax)) return S.zmin;
    const gx = Math.min(Math.max((x - S.xmin) / sim.dx, 0), sim.nx);
    const gy = Math.min(Math.max((y - S.ymin) / sim.dy, 0), sim.ny);
    const i = Math.min(Math.floor(gx), Math.max(0, sim.nx - 1));
    const j = Math.min(Math.floor(gy), Math.max(0, sim.ny - 1));
    const fx = gx - i, fy = gy - j;
    const h = sim.heights, vx = sim.vx;
    const a = h[j * vx + i], b = h[j * vx + i + 1];
    const c = h[(j + 1) * vx + i], d = h[(j + 1) * vx + i + 1];
    // Same split as StockMeshRenderer.tileShape: triangles (a, b, d) and (a, d, c)
    return fx >= fy
        ? a + fx * (b - a) + fy * (d - b)
        : a + fy * (c - a) + fx * (d - c);
}

function displaySimulator(parser) {
    const cells = X.stockSimCells(parser.simMeta.stock, parser.simMeta.tools);
    const sim = new X.StockSimulator(parser.simMeta.stock, parser.simMeta.tools, { maxCells: cells });
    sim.setSegments(parser.segments);
    return sim;
}

/** Highest grid vertex under a tool of `radius` at (x, y), for a plate resting on the stock */
function displayTop(sim, x, y, radius) {
    const S = sim.stock;
    const r = Math.max(radius, Math.min(sim.dx, sim.dy));
    const i0 = Math.max(0, Math.ceil((x - r - S.xmin) / sim.dx));
    const i1 = Math.min(sim.nx, Math.floor((x + r - S.xmin) / sim.dx));
    const j0 = Math.max(0, Math.ceil((y - r - S.ymin) / sim.dy));
    const j1 = Math.min(sim.ny, Math.floor((y + r - S.ymin) / sim.dy));
    let top = -Infinity;
    for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
            if (Math.hypot(S.xmin + i * sim.dx - x, S.ymin + j * sim.dy - y) > r) continue;
            top = Math.max(top, sim.heights[j * sim.vx + i]);
        }
    }
    return top === -Infinity ? displaySurfaceAt(sim, x, y) : top;
}

async function parseFile(name) {
    const text = fs.readFileSync(path.join(repo, 'tests/fixtures', name), 'utf8');
    const parser = new X.GCodeParser();
    await parser.parseString(text);
    return { parser, text };
}

const probeMoves = (parser) => parser.segments.map((s, i) => [i, s]).filter(([, s]) => s.type === 'probe' && !!s.probe);
const alarmEvents = (parser) => parser.events.filter(e => e.kind === 'alarm');
const probeEvents = (parser) => parser.events.filter(e => e.kind === 'probe');

function eventZ(text) {
    const m = /Z(-?\d+(?:\.\d+)?)/.exec(text || '');
    return m ? parseFloat(m[1]) : NaN;
}

(async () => {
    // --- A. step then probe -------------------------------------------------
    {
        console.log('probe-step-then-probe.nc');
        const { parser } = await parseFile('probe-step-then-probe.nc');
        const sim = displaySimulator(parser);
        const probes = probeMoves(parser);
        ok('two contact points', probes.length === 2);
        const events = probeEvents(parser);
        for (const [i, s] of probes) {
            sim.advanceTo(i);
            const drawn = displaySurfaceAt(sim, s.end.x, s.end.y);
            eq(`contact ${s.end.x},${s.end.y} on drawn surface`, s.end.z, drawn);
            const ev = events.find(e => e.lineNum === s.lineNum);
            eq(`event Z matches tip at line ${s.lineNum}`, eventZ(ev && ev.text), s.end.z - parser.workOffset().z);
        }
        eq('step floor contact is Z-2', probes[0][1].end.z, -2);
        eq('uncut top contact is Z0', probes[1][1].end.z, 0);
    }

    // --- B. P plate then cut ------------------------------------------------
    {
        console.log('probe-plate-then-cut.nc');
        const { parser } = await parseFile('probe-plate-then-cut.nc');
        const sim = displaySimulator(parser);
        const probes = probeMoves(parser);
        ok('one contact point', probes.length === 1);
        const [i, s] = probes[0];
        sim.advanceTo(i);
        const tool = sim.tools.get(s.toolNumber) || sim.defaultTool;
        const surfaceTop = displayTop(sim, s.end.x, s.end.y, tool.radius);
        eq('plate tip on plate top', s.end.z, surfaceTop + s.probe.plate);
        eq('probe.surface is the stock top under the plate', s.probe.surface, surfaceTop);
        // The contact reads P in the active system after the update
        eq('contact reads P', s.end.z - parser.workOffset().z, s.probe.plate);
        // A cut programmed at Z = P lands physically on the plate top
        const cuts = parser.segments.filter(seg => seg.type === 'cut');
        const atPlateTop = cuts.find(c => Math.abs(c.end.x - 40) < 1e-6 && Math.abs(c.end.y - 20) < 1e-6);
        ok('a following cut reached X40', !!atPlateTop);
        if (atPlateTop) eq('that cut is on the plate top', atPlateTop.end.z, surfaceTop + s.probe.plate, 1e-2);
    }

    // --- C. units switch before probing ------------------------------------
    {
        console.log('probe-units-switch.nc');
        const { parser } = await parseFile('probe-units-switch.nc');
        ok('ended in inches', parser.units === 'inches');
        const sim = displaySimulator(parser);
        const probes = probeMoves(parser);
        ok('two contacts (the same place twice)', probes.length === 2);
        ok('both contacts are the same height', Math.abs(probes[0][1].end.z - probes[1][1].end.z) <= EPS);
        // Physical height is the mm cut (-2 mm) expressed in inches, not scaled twice
        eq('step contact keeps its physical place', probes[0][1].end.z, -2 / 25.4);
        for (const [i, s] of probes) {
            sim.advanceTo(i);
            eq(`contact ${s.end.x},${s.end.y} on drawn surface`, s.end.z, displaySurfaceAt(sim, s.end.x, s.end.y));
        }
    }

    // --- D. failed probe then repeat ---------------------------------------
    {
        console.log('probe-fail-then-succeed.nc');
        const { parser } = await parseFile('probe-fail-then-succeed.nc');
        ok('exactly one alarm (only the G38.2 miss)', alarmEvents(parser).length === 1);
        const probes = probeMoves(parser);
        ok('two contact points (both good probes)', probes.length === 2);
        ok('no contact point for the failed probe', probes.every(([, s]) => s.lineNum !== 14));
        ok('two contacts at the same height', probes.length === 2 && Math.abs(probes[0][1].end.z - probes[1][1].end.z) <= EPS);
        eq('both touch the step floor', probes[0][1].end.z, -2);
        // The failed probe didn't disturb the offset
        eq('work offset untouched by the failure', parser.workOffset().z, 0);
    }

    // --- E. arc then probe --------------------------------------------------
    {
        console.log('probe-after-arc.nc');
        const { parser } = await parseFile('probe-after-arc.nc');
        const sim = displaySimulator(parser);
        const probes = probeMoves(parser);
        ok('two contacts', probes.length === 2);
        const [i0, s0] = probes[0];
        const [i1, s1] = probes[1];
        sim.advanceTo(i0);
        const onArc = displaySurfaceAt(sim, s0.end.x, s0.end.y);
        eq('probe on the arc path touches the arc floor', s0.end.z, onArc);
        eq('the arc removed material to Z-2', s0.end.z, -2);
        sim.advanceTo(i1);
        eq('probe off the arc touches the uncut top', s1.end.z, displaySurfaceAt(sim, s1.end.x, s1.end.y));
        eq('the off-arc point is uncut', s1.end.z, 0);
        // The arc really is many segments in the list
        const arcSegs = parser.segments.filter(s => s.lineNum === 12 && s.type === 'cut');
        ok('the arc was tessellated into many segments', arcSegs.length > 8, `got ${arcSegs.length}`);
    }

    // --- Determinism across all fixtures -----------------------------------
    console.log('determinism');
    for (const name of fs.readdirSync(path.join(repo, 'tests/fixtures')).filter(n => n.endsWith('.nc'))) {
        const a = await parseFile(name);
        const b = await parseFile(name);
        ok(`${name}: segments identical`, JSON.stringify(a.parser.segments) === JSON.stringify(b.parser.segments));
        ok(`${name}: events identical`, JSON.stringify(a.parser.events) === JSON.stringify(b.parser.events));
    }

    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures === 0 ? 0 : 1);
})();
