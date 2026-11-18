// Impasto – app controller.
import { Surface } from "./grid.js";
import { Editor2D } from "./editor2d.js";
import { View3D } from "./view3d.js";
import { TYPES, PATTERNS, newElement, build, setAsyncCallback, rasterOf, defaultClusterMap } from "./elements.js";
import { polyLength, hexToRgb, smoothPolyline, simplify } from "./geom.js";
import { initLang, getLang, setLang, onLang, applyStatic, t } from "./i18n.js";
import { initTips } from "./tooltip.js";

const $ = (id) => document.getElementById(id);

// key, label key, min, max, step, unit, scale(display factor), main?, tip key
const PARAM_UI = [
  ["z_offset", "param.zOffset", -0.3, 0.6, 0.01, "mm", 1, true, "tip.param.z_offset"],
  ["line_width", "param.lineWidth", 0.2, 1.0, 0.01, "mm", 1, true, "tip.param.line_width"],
  ["flow", "param.flow", 0.3, 2.5, 0.01, "%", 100, true, "tip.param.flow"],
  ["speed", "param.speed", 2, 60, 0.5, "mm/s", 1, true, "tip.param.speed"],
  ["dir_min_rise", "param.dirMinRise", 0, 5, 0.01, "mm", 1, true, "tip.param.dir_min_rise"],
  ["dir_travel_weight", "param.dirTravelWeight", 0, 40, 0.5, "×", 1, true, "tip.param.dir_travel_weight"],
  ["hop", "param.hop", 0.2, 5, 0.1, "mm", 1, false, "tip.param.hop"],
  ["travel_speed", "param.travel", 20, 300, 5, "mm/s", 1, false, ""],
  ["retract", "param.retract", -1, 3, 0.05, "mm", 1, false, "tip.param.retract"],
  ["retract_speed", "param.retractSpeed", 5, 60, 1, "mm/s", 1, false, ""],
  ["step", "param.step", 0.05, 1, 0.05, "mm", 1, false, "tip.param.step"],
  ["min_len", "param.minLen", 0, 5, 0.1, "mm", 1, false, "tip.param.min_len"],
  ["ramp", "param.ramp", 0.05, 2, 0.05, "dz/ds", 1, false, "tip.param.ramp"],
  ["dir_end_len", "param.dirEndLen", 0, 5, 0.1, "mm", 1, false, "tip.param.dir_end_len"],
  ["dir_cap", "param.dirCap", 0, 40, 1, "", 1, false, "tip.param.dir_cap"],
  ["short_travel", "param.shortTravel", 0, 5, 0.1, "mm", 1, false, "tip.param.short_travel"],
  ["prime", "param.prime", 0, 3, 0.05, "mm", 1, false, "tip.param.prime"],
  ["purge_factor", "param.purgeFactor", 0, 3, 0.05, "×", 1, false, "tip.param.purge_factor"],
  ["min_purge", "param.minPurge", 0, 400, 5, "mm³", 1, false, "tip.param.min_purge"],
  ["accel", "param.accel", 200, 10000, 100, "mm/s²", 1, false, ""],
  ["fan", "param.fan", -1, 100, 1, "%", 1, false, "tip.param.fan"],
  ["wipe", "param.wipe", -1, 5, 0.1, "mm", 1, false, "tip.param.wipe"],
  ["retract_before_wipe", "param.retractBeforeWipe", -1, 100, 5, "%", 1, false, "tip.param.retract_before_wipe"],
  ["coast", "param.coast", 0, 2, 0.05, "mm", 1, false, "tip.param.coast"],
  ["hop_bead", "param.hopBead", 0.1, 2, 0.05, "mm", 1, false, "tip.param.hop_bead"],
  ["curve_radius", "param.curveRadius", 0, 5, 0.1, "mm", 1, false, "tip.param.curve_radius"],
  ["curve_min", "param.curveMin", 0.1, 1, 0.05, "%", 100, false, "tip.param.curve_min"],
  ["dir_stub_slope", "param.dirStubSlope", 0, 2, 0.05, "dz/ds", 1, false, "tip.param.dir_stub_slope"],
  ["warp_ends", "param.warpEnds", 0, 2, 0.05, "mm", 1, false, "tip.param.warp_ends"],
  ["warp_edge", "param.warpEdge", 0, 1, 0.05, "mm", 1, false, "tip.param.warp_edge"],
  ["warp_edge_width", "param.warpEdgeWidth", 0.5, 20, 0.5, "mm", 1, false, "tip.param.warp_edge_width"],
  ["slope_comp", "param.slopeComp", 0, 1, 0.05, "%", 100, false, "tip.param.slope_comp"],
  ["probe_region", "param.probeRegion", 0, 120, 5, "mm", 1, false, "tip.param.probe_region"],
  ["probe_temp", "param.probeTemp", 0, 200, 5, "°C", 1, false, "tip.param.probe_temp"],
  ["probe_depth", "param.probeDepth", 0.1, 2, 0.05, "mm", 1, false, "tip.param.probe_depth"],
  ["probe_clear", "param.probeClear", 0.5, 5, 0.1, "mm", 1, false, "tip.param.probe_clear"],
  ["probe_speed", "param.probeSpeed", 1, 20, 1, "mm/s", 1, false, "tip.param.probe_speed"],
];
const PARAM_BOOL = [
  ["dir_opt", "param.dirOpt", "tip.param.dir_opt"],
  ["gap_flow", "param.gapFlow", "tip.param.gap_flow"],
  ["stack", "param.stack", "tip.param.stack"],
  ["use_filament_flow_ratio", "param.useFilamentFlow", "tip.param.use_filament_flow_ratio"],
  ["probe", "param.probe", "tip.param.probe"],
];

const app = {
  files: [], fid: null, plate: 1, meta: null, surf: null, orig: null,
  elements: [], selectedId: null, built: new Map(),
  mask: { angle: 35, inset: 0.3, zmin: 0, minArea: 2, exclude: [] },
  analysis: { sigma: 0.6, tip: 0.3 },
  params: {},
  undo: [], redo: [],
  showRealWidth: true,
  gen: null, genStale: true, genLines: null,
  lastSlot: null,
};
window.impasto = app;

// ------------------------------------------------------------------ helpers
async function api(path, opts = {}) {
  const headers = Object.assign({ "X-Impasto-Lang": getLang() }, opts.headers || {});
  const r = await fetch(path, { ...opts, headers });
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = j.detail || msg; } catch {}
    throw new Error(msg);
  }
  return r;
}

function status(msg, cls = "") { const s = $("status"); s.textContent = msg; s.className = "status " + cls; }
let toastT;
function toast(msg, err = false) {
  const t = $("toast"); t.textContent = msg; t.className = "toast" + (err ? " err" : "");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add("hidden"), err ? 6000 : 2600);
}
function fmtTime(s) { s = Math.round(s); const m = Math.floor(s / 60); return m ? t("time.min", { m, s: s % 60 }) : t("time.s", { s }); }

// hover-info marker (the explanatory text lives in the tooltip, not in the layout)
function infoIcon(text) {
  const s = document.createElement("span");
  s.className = "info-i"; s.tabIndex = 0; s.textContent = "i";
  if (text) s.dataset.tip = text;
  return s;
}

app.slotColor = (slot) => app.meta?.filaments?.[slot]?.color || "#999999";
app.hasTf = (el) => TYPES[el.type].tf;
app.selected = () => app.elements.find(e => e.id === app.selectedId) || null;
app.currentSlot = () => app.selected()?.slot ?? app.lastSlot ?? 0;
app.surfaceColor = () => {
  const c = hexToRgb(app.slotColor(app.meta?.last_filament ?? 0));
  return c.map(v => 0.25 + 0.6 * (v / 255));
};

// ------------------------------------------------------------------ editor + 3d
const editor = new Editor2D($("cv2d"), app);
const v3 = new View3D($("v3wrap"), app);
app.editor = editor; app.v3 = v3;

app.cursorInfo = (w) => {
  const s = app.surf;
  if (!s) return;
  const c = s.cellOf(w[0], w[1]);
  let txt = t("cursor.xy", { x: w[0].toFixed(2), y: w[1].toFixed(2) });
  if (c >= 0 && s.valid[c]) txt += `  Z ${s.H[c].toFixed(2)}  ∠ ${(s.S[c] / 2).toFixed(1)}°  ${s.mask[c] ? t("canvas.usable") : s.base[c] ? t("canvas.edge") : "–"}`;
  $("cursorInfo").textContent = txt;
};

// ------------------------------------------------------------------ build pipeline
const ctx = { get lineWidth() { return app.params.line_width || 0.45; } };

function rebuildElement(el) {
  const b = build(el, app.surf, ctx);
  const clipped = [];
  let len = 0;
  const margin = +el.props.margin || 0;
  const mask = margin > 0 ? app.surf.maskMargin(margin) : app.surf.mask;
  const sIt = Math.round(+el.props.smoothIter || 0), sSt = +el.props.smoothStrength || 0;
  const sStep = Math.max(0.05, ctx.lineWidth * 0.5);
  for (const l of b.lines) {
    let pts = l.pts;
    if (sIt > 0 && sSt > 0 && pts.length > 2) {
      pts = smoothPolyline(pts, sSt, sIt, l.closed, sStep);
      pts = simplify(pts, 0.004);
    }
    const pieces = app.surf.clipTo(mask, pts, l.closed);
    for (const p of pieces) {
      const L = polyLength(p);
      if (L < 0.3) continue;
      len += L;
      clipped.push({ slot: l.slot, pts: p, closed: !!p.closed, layer: el.layer | 0 });
    }
  }
  b.clipped = clipped;
  b.len = len;
  b.paths = null;
  app.built.set(el.id, b);
  return b;
}

function rebuildAll() {
  if (!app.surf) return;
  for (const el of app.elements) rebuildElement(el);
  afterChange();
}

let d3T, saveT;
function afterChange(live = false) {
  editor.render();
  markStale();
  renderList();
  updateDesignStats();
  clearTimeout(d3T);
  d3T = setTimeout(update3dDesign, live ? 250 : 60);
  if (!live) { clearTimeout(saveT); saveT = setTimeout(saveDesign, 1200); }
}

app.changed = (el, opt = {}) => {
  if (!app.surf) return;
  rebuildElement(el);
  if (opt.props) renderProps();
  afterChange(!!opt.live);
  if (!opt.live && el.id === app.selectedId) syncTfFields();
  else if (opt.live && el.id === app.selectedId) syncTfFields();
};

setAsyncCallback((el, r) => {
  const real = app.elements.find(e => e.id === el.id);
  if (!real) return;
  if (real.type === "image" && r && r.colors) {
    if (!real.props.map || real.props.map.length !== r.colors.length)
      real.props.map = defaultClusterMap(r, app.meta.filaments, real.slot);
    if (!real._sized) { real._sized = true; }
  }
  app.changed(real);
  if (real.id === app.selectedId) {
    // Rebuilding the panel while the user types would destroy the focused field (text element
    // rasterises asynchronously after every keystroke) - only refresh the info line then.
    if (typingInProps()) updatePropsInfo(real);
    else renderProps();
  }
});

function typingInProps() {
  const a = document.activeElement;
  return !!a && P.contains(a) && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type !== "range" && a.type !== "checkbox"));
}
function updatePropsInfo(el) {
  const b = app.built.get(el.id);
  let h = P.querySelector("p.hint.built-info");
  if (!b?.info) { h?.remove(); return; }
  if (!h) { h = hint(""); h.classList.add("built-info"); P.append(h); }
  h.textContent = b.info;
}

// Element order is the print order: the first element goes onto the part, every later one
// is laid onto whatever is below it. The list shows them top-down.
function allDesignLines() {
  const out = [];
  app.elements.forEach((el, i) => {
    if (!el.visible) return;
    const b = app.built.get(el.id);
    if (!b) return;
    for (const c of b.clipped) out.push({ ...c, order: i });
  });
  return out;
}

function update3dDesign() {
  if (!v3.visible) return;
  if (app.gen && !app.genStale) { v3.clear("design"); return; }
  v3.setDesign(allDesignLines(), app.params.line_width, app.params.z_offset);
}

function updateDesignStats() {
  const bar = $("statsBar");
  if (app.gen && !app.genStale) return renderGenStats();
  const per = {};
  let n = 0;
  for (const l of allDesignLines()) { per[l.slot] = (per[l.slot] || 0) + polyLength(l.pts); n++; }
  const parts = Object.entries(per).map(([s, L]) => `<span><i class="sw" style="background:${app.slotColor(+s)}"></i> ${(L / 1000).toFixed(2)} m</span>`);
  const pend = app.elements.some(e => app.built.get(e.id)?.pending);
  bar.innerHTML = app.surf
    ? `<span>${t("stats.design")}</span><b>${n}</b> ${t("stats.strokes")} ${parts.join(" ")} ${pend ? `<span>${t("stats.loading")}</span>` : ""}${app.gen ? `<span style="color:var(--acc)">${t("stats.stale")}</span>` : ""}`
    : t("stats.loadHint");
}

function renderGenStats() {
  const st = app.gen.stats;
  const parts = Object.entries(st.usage || {}).map(([s, u]) =>
    `<span><i class="sw" style="background:${app.slotColor(+s)}"></i> ${(st.length_mm[s] / 1000).toFixed(2)} m · ${u.g.toFixed(2)} g</span>`);
  const di = st.dir;
  const dtot = di ? di.up_mm + di.down_mm : 0;
  const dirInfo = di ? `<span title="${t("stats.cutsTip", { mm: di.before_mm.toFixed(1), max: di.down_max ? t("stats.cutsMax", { d: di.down_max.toFixed(2) }) : "" })}">${t("stats.uphill")}
    <b>${(dtot > 0 ? (100 * di.up_mm) / dtot : 100).toFixed(1)} %</b> · <b>${di.cuts}</b> ${t("stats.cuts")}</span>` : "";
  const trv = +((di && di.travel_mm) || 0);
  const travelInfo = trv > 0
    ? `<span title="${t("stats.travelTip")}">${t("stats.travel")} <b>${trv.toFixed(0)} mm</b></span>`
    : "";
  const nr = st.retracts ?? di?.retracts;
  const retrInfo = nr != null
    ? `<span title="${t("stats.retractsTip", { short: st.short_travels ?? 0, wipe: (+st.wipe_mm || 0).toFixed(0), coast: (+st.coast_mm || 0).toFixed(1) })}">${t("stats.retracts")} <b>${nr}</b></span>`
    : "";
  const touchInfo = st.touches
    ? `<span title="${t("stats.touchesTip", { skipped: st.touch_skipped || 0 })}">${t("stats.touches")} <b>${st.touches}</b></span>` : "";
  const downInfo = di && di.down_mm > 0.05
    ? `<span title="${t("stats.downTip")}">${t("stats.down")} <b>${di.down_mm.toFixed(0)} mm</b></span>` : "";
  const stk = +st.stacked_mm || 0;
  const stackInfo = stk > 0.5
    ? `<span title="${t("stats.stackedTip")}">${t("stats.stacked")} <b>${stk.toFixed(0)} mm</b></span>`
    : "";
  const batchInfo = st.batches != null
    ? `<span title="${t("stats.batchesTip")}">${t("stats.batches")} <b>${st.batches}</b></span>` : "";
  const precInfo = st.precedences
    ? `<span title="${t("stats.precedencesTip")}">${t("stats.precedences")} <b>${st.precedences}</b></span>` : "";
  $("statsBar").innerHTML = `<span>NON-PLANAR</span><b>${fmtTime(st.time_s)}</b>
    <span>${t("stats.toolchanges")} <b>${st.toolchanges}</b></span><span>${t("stats.purge")} <b>${(st.purge_mm3 / 1000).toFixed(2)} cm³</b></span>
    ${parts.join(" ")}<span>Z ${st.min_z.toFixed(2)}–${st.max_z.toFixed(2)}</span>${stackInfo}${batchInfo}${precInfo}${travelInfo}${retrInfo}${touchInfo}${dirInfo}${downInfo}<span>${t("stats.linesMs", { lines: app.gen.lines, ms: st.gen_ms })}</span>
    ${st.collisions == null ? "" : `<span style="color:${st.collisions ? "var(--err,#ff3b30)" : "var(--ok,#6c6)"}">${t("stats.collisions")} <b>${st.collisions}</b> · ${st.coll_ms} ms</span>`}`;
}

// ------------------------------------------------------------------ print head / collision check
function defaultHead(nozzle) {
  if (nozzle >= 0.75) return "bambu-a1-mini-nozzle-08";
  if (nozzle >= 0.55) return "bambu-a1-mini-nozzle-06";
  return "bambu-a1-mini";
}
async function loadHeads() {
  const sel = $("headSel");
  let list = [];
  try { list = await (await api("/api/heads")).json(); } catch { return; }
  list.sort((a, b) => a.name.localeCompare(b.name, getLang()));
  sel.innerHTML = `<option value="">${esc(t("head.off"))}</option>` +
    list.map(h => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join("");
  app.heads = list;
  sel.value = app.head || "";
}
function headKey() { return `impasto.head.${app.meta?.printer || ""}.${app.meta?.nozzle || ""}`; }
// older builds stored the same values under "npg.*"
function lsOld(key) { return localStorage.getItem("npg." + key); }
async function applyHead(id, persist = true) {
  const sel = $("headSel");
  if (id && !app.heads?.some(h => h.id === id)) id = "";
  sel.value = id || "";
  app.head = sel.value || null;
  if (persist) localStorage.setItem(headKey(), app.head || "off");
  $("collInfo").textContent = "";
  let json = null;
  if (app.head) { try { json = await (await api(`/api/heads/${app.head}`)).json(); } catch {} }
  v3.setHead(json);
}
function selectHeadForJob() {
  const stored = localStorage.getItem(headKey()) ?? lsOld(`head.${app.meta?.printer || ""}.${app.meta?.nozzle || ""}`);
  const id = stored === "off" ? "" : (stored || defaultHead(app.meta?.nozzle || 0.4));
  return applyHead(id, false);
}
$("headSel").onchange = (e) => { applyHead(e.target.value); markStale(); };

function showCollisions(coll) {
  const info = $("collInfo");
  v3.setCollisions(coll);
  v3.show("coll", $("v3Coll").checked);
  v3.setXray($("v3Xray").checked);
  if (!coll) { info.textContent = ""; return; }
  if (!coll.count) { info.innerHTML = `<span style="color:var(--ok,#6c6)">${esc(t("coll.none"))}</span>`; return; }
  const names = [...new Set(coll.box_names)].join(", ");
  info.innerHTML = t("coll.info", { n: coll.count, extrusion: coll.extrusion, d: coll.max_depth.toFixed(2), names: esc(names) });
  toast(t("toast.collision", { n: coll.count, d: coll.max_depth.toFixed(2), names }), true);
}

function markStale() {
  if (app.gen && !app.genStale) {
    app.genStale = true;
    v3.clear("gcode"); v3.clear("travel"); v3.clear("marker"); v3.clear("coll"); v3.clear("cuts");
    $("playbar").classList.add("hidden");
    $("codeView").classList.add("hidden");
  }
}

// a saved design may still carry an old default that has changed since
function warnOldParams(p) {
  if (!p) return;
  if (p.dir_travel_weight === 2) {
    setTimeout(() => toast(t("toast.oldWeight", { now: app.meta?.defaults?.dir_travel_weight ?? 10 }), true), 400);
  }
}

// ------------------------------------------------------------------ undo
function snapshot() { return JSON.stringify({ elements: app.elements, mask: app.mask, params: app.params }); }
app.pushUndo = () => {
  app.undo.push(snapshot());
  if (app.undo.length > 80) app.undo.shift();
  app.redo = [];
};
function restore(snap) {
  const o = JSON.parse(snap);
  app.elements = o.elements;
  const maskChanged = JSON.stringify(o.mask) !== JSON.stringify(app.mask);
  app.mask = o.mask;
  if (o.params && JSON.stringify(o.params) !== JSON.stringify(app.params)) { app.params = o.params; renderParams(); }
  if (!app.elements.find(e => e.id === app.selectedId)) app.selectedId = null;
  if (maskChanged) { syncMaskUi(); recomputeMask(); } else rebuildAll();
  renderProps();
}
function doUndo() { if (!app.undo.length) return; app.redo.push(snapshot()); restore(app.undo.pop()); }
function doRedo() { if (!app.redo.length) return; app.undo.push(snapshot()); restore(app.redo.pop()); }

// ------------------------------------------------------------------ files
async function refreshFiles(selectId) {
  app.files = await (await api("/api/files")).json();
  const sel = $("fileSel");
  sel.innerHTML = app.files.length ? "" : `<option value=''>${esc(t("files.none"))}</option>`;
  for (const f of app.files) {
    const o = document.createElement("option");
    o.value = f.id;
    o.textContent = `${f.filename} (${(f.size / 1e6).toFixed(1)} MB)`;
    sel.appendChild(o);
  }
  if (selectId) sel.value = selectId;
}

function fillPlates(f, plate) {
  const ps = $("plateSel");
  ps.innerHTML = "";
  for (const p of f?.plates || [1]) {
    const o = document.createElement("option"); o.value = p; o.textContent = t("plate.n", { n: p }); ps.appendChild(o);
  }
  ps.value = plate;
  ps.style.display = f && f.kind === "3mf" && f.plates.length > 1 ? "" : "none";
}

async function upload(file) {
  status(t("status.uploading", { name: file.name }));
  const fd = new FormData();
  fd.append("file", file, file.name);
  try {
    const meta = await (await api("/api/upload", { method: "POST", body: fd })).json();
    await refreshFiles(meta.id);
    await openFile(meta.id, meta.plates[0]);
  } catch (e) { status(e.message, "err"); toast(e.message, true); }
}

async function openFile(fid, plate) {
  if (!fid) return;
  await saveDesign();
  status(t("status.analyzing"));
  const f = app.files.find(x => x.id === fid);
  fillPlates(f, plate);
  try {
    const t0 = performance.now();
    const meta = await (await api(`/api/job/${fid}?plate=${plate}`)).json();
    app.fid = fid; app.plate = plate; app.meta = meta;
    localStorage.setItem("impasto.last", JSON.stringify({ fid, plate }));
    // design
    let design = null;
    try { design = await (await api(`/api/job/${fid}/design?plate=${plate}`)).json(); } catch {}
    app.params = Object.assign({}, meta.defaults, design?.params || {});
    warnOldParams(design?.params);
    app.mask = Object.assign({ angle: 35, inset: 0.3, zmin: 0, minArea: 2, exclude: [] }, design?.mask || {});
    app.analysis = Object.assign({ sigma: 0.6, tip: 0.3 }, design?.analysis || {});
    app.elements = design?.elements || [];
    app.selectedId = null; app.undo = []; app.redo = [];
    app.gen = null; app.genStale = true;
    app.lastSlot = design?.lastSlot ?? pickContrastSlot();
    $("exp3mf").disabled = $("expGcode").disabled = true;
    $("sendBtn").disabled = false;      // generates on demand
    await loadGrid();
    await selectHeadForJob();
    syncMaskUi();
    renderFilaments();
    renderParams();
    renderProps();
    editor.fit();
    status(t("status.loaded", { filename: meta.filename, printer: meta.printer, layers: meta.layers, z: meta.max_z.toFixed(2), s: ((performance.now() - t0) / 1000).toFixed(1) }), "ok");
    $("dropHint").classList.add("hidden");
    loadOriginal();
    app.variantName = null;
    refreshVariants();
  } catch (e) {
    console.error(e);
    status(e.message, "err"); toast(e.message, true);
  }
}

async function loadGrid() {
  const buf = await (await api(`/api/job/${app.fid}/grid?plate=${app.plate}&sigma=${app.analysis.sigma}&tip=${app.analysis.tip}`)).arrayBuffer();
  const s = new Surface(buf);
  app.surf = s;
  if (!app.mask.zmin || app.mask.zmin < s.zmin) app.mask.zmin = Math.floor(s.zmin * 10) / 10;
  s.computeMask(app.mask);
  maskInfo();
  editor.setSurface(s);
  v3.setSurface(s);
  rebuildAll();
}

async function loadOriginal() {
  if (!$("v3Orig").checked || !app.meta) return;
  const zmin = parseFloat($("v3Zmin").value);
  const buf = await (await api(`/api/job/${app.fid}/toolpaths?plate=${app.plate}&zmin=${isFinite(zmin) ? zmin : app.meta.max_z - 1.5}`)).arrayBuffer();
  const dv = new DataView(buf);
  const hl = dv.getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  const n = head.n;
  let o = 4 + hl;
  const seg = new Float32Array(buf.slice(o, o + n * 20)); o += n * 20;
  o += n * 2;
  const fil = new Int8Array(buf.slice(o, o + n));
  v3.setOriginal({ n, seg, fil, zmax: app.meta.max_z }, app.meta.filaments.map(f => f.color));
}

function pickContrastSlot() {
  const top = hexToRgb(app.slotColor(app.meta.last_filament));
  let best = 0, bd = -1;
  for (const f of app.meta.filaments) {
    const c = hexToRgb(f.color);
    const d = (c[0] - top[0]) ** 2 + (c[1] - top[1]) ** 2 + (c[2] - top[2]) ** 2;
    if (d > bd) { bd = d; best = f.slot; }
  }
  return best;
}

async function saveDesign() {
  clearTimeout(saveT);
  if (!app.fid) return;
  const body = designBody();
  try { await api(`/api/job/${app.fid}/design?plate=${app.plate}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
  catch (e) { console.warn("save failed", e); }
}

// ------------------------------------------------------------------ variants
function designBody() {
  return { version: 1, mask: app.mask, analysis: app.analysis, params: app.params, elements: app.elements, lastSlot: app.lastSlot };
}
const varUrl = (name) => `/api/job/${app.fid}/variants${name != null ? "/" + encodeURIComponent(name) : ""}?plate=${app.plate}`;

async function refreshVariants() {
  const ul = $("varList");
  ul.innerHTML = "";
  if (!app.fid) return;
  let list = [];
  try { list = await (await api(varUrl())).json(); } catch { return; }
  app.variants = list;
  const loc = getLang() === "de" ? "de-DE" : "en-GB";
  for (const v of list) {
    const li = document.createElement("li");
    li.className = v.name === app.variantName ? "sel" : "";
    const d = new Date(v.saved * 1000);
    li.title = t("variant.tipSaved", { date: d.toLocaleString(loc) });
    li.innerHTML = `<span class="nm">${esc(v.name)}</span><span class="ty">${esc(t("variant.elements", { n: v.elements }))} · ${d.toLocaleDateString(loc, { day: "2-digit", month: "2-digit" })}</span>
      <button title="${esc(t("variant.overwrite"))}">⤓</button><button title="${esc(t("variant.delete"))}">✕</button>`;
    li.onclick = (e) => { if (e.target.tagName !== "BUTTON") loadVariant(v.name); };
    const [bOver, bDel] = li.querySelectorAll("button");
    bOver.onclick = () => saveVariant(v.name, true);
    bDel.onclick = async () => {
      if (!confirm(t("confirm.deleteVariant", { name: v.name }))) return;
      await api(varUrl(v.name), { method: "DELETE" });
      if (app.variantName === v.name) app.variantName = null;
      refreshVariants();
    };
    ul.appendChild(li);
  }
}

async function saveVariant(name, force = false) {
  name = (name || "").trim();
  if (!app.fid) { toast(t("toast.loadFileFirst")); return; }
  if (!name) { toast(t("toast.namePrompt")); $("varName").focus(); return; }
  if (!force && (app.variants || []).some(v => v.name === name) && !confirm(t("confirm.overwriteVariant", { name }))) return;
  try {
    await api(varUrl(name), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(designBody()) });
    app.variantName = name;
    toast(t("toast.variantSaved", { name }));
    refreshVariants();
  } catch (e) { toast(e.message, true); }
}

async function loadVariant(name) {
  try {
    const v = await (await api(varUrl(name))).json();
    const d = v.design || {};
    app.pushUndo();
    const anaChanged = JSON.stringify(d.analysis || app.analysis) !== JSON.stringify(app.analysis);
    app.elements = d.elements || [];
    app.built.clear();
    app.mask = Object.assign({ angle: 35, inset: 0.3, zmin: 0, minArea: 2, exclude: [] }, d.mask || {});
    app.params = Object.assign({}, app.meta.defaults, d.params || {});
    warnOldParams(d.params);
    if (d.analysis) app.analysis = Object.assign({ sigma: 0.6, tip: 0.3 }, d.analysis);
    if (d.lastSlot != null) app.lastSlot = d.lastSlot;
    app.selectedId = null;
    if (anaChanged) await loadGrid();
    syncMaskUi(); recomputeMask();
    renderParams(); renderProps();
    app.variantName = name;
    $("varName").value = name;
    saveDesign();
    refreshVariants();
    status(t("status.variantLoaded", { name }), "ok");
  } catch (e) { toast(e.message, true); }
}
$("varSave").onclick = () => saveVariant($("varName").value);
$("varName").addEventListener("keydown", (e) => { if (e.key === "Enter") saveVariant($("varName").value); e.stopPropagation(); });

// ------------------------------------------------------------------ mask UI
function syncMaskUi() {
  const s = app.surf;
  $("mAngle").value = app.mask.angle;
  $("mInset").value = app.mask.inset;
  $("mMinArea").value = app.mask.minArea;
  if (s) { $("mZmin").min = Math.floor(s.zmin * 10) / 10; $("mZmin").max = Math.ceil(s.zmax * 10) / 10; }
  $("mZmin").value = app.mask.zmin;
  $("aSigma").value = app.analysis.sigma;
  $("aTip").value = app.analysis.tip;
  updateMaskLabels();
}
function updateMaskLabels() {
  $("mAngleV").textContent = `${(+app.mask.angle).toFixed(1)}°`;
  $("mInsetV").textContent = `${(+app.mask.inset).toFixed(2)} mm`;
  $("mZminV").textContent = `${(+app.mask.zmin).toFixed(2)} mm`;
  $("mMinAreaV").textContent = `${(+app.mask.minArea).toFixed(1)} mm²`;
}
function maskInfo() {
  const s = app.surf;
  if (!s) return;
  const excl = app.mask.exclude.length ? t("mask.excl", { n: app.mask.exclude.length }) : "";
  $("maskInfo").textContent = t("mask.info", { area: s.maskArea.toFixed(0), on: s.regionsOn, total: s.regionsTotal, excl });
}
let maskT;
function recomputeMask(live = false) {
  if (!app.surf) return;
  updateMaskLabels();
  const run = () => {
    app.surf.computeMask(app.mask);
    editor.updateMask();
    v3.updateMask();
    rebuildAll();
    maskInfo();
  };
  clearTimeout(maskT);
  if (live) maskT = setTimeout(run, 30); else run();
}
for (const [id, key] of [["mAngle", "angle"], ["mInset", "inset"], ["mZmin", "zmin"], ["mMinArea", "minArea"]]) {
  $(id).addEventListener("pointerdown", () => app.pushUndo());
  $(id).addEventListener("input", (e) => { app.mask[key] = parseFloat(e.target.value); recomputeMask(true); });
}
for (const [id, key] of [["aSigma", "sigma"], ["aTip", "tip"]]) {
  $(id).addEventListener("change", async (e) => {
    app.analysis[key] = parseFloat(e.target.value);
    status(t("status.analysisRunning"));
    await loadGrid();
    status(t("status.analysisDone"), "ok");
    saveDesign();
  });
}
app.toggleRegion = (w) => {
  const s = app.surf;
  const c = s.cellOf(w[0], w[1]);
  if (c < 0 || s.labels[c] < 0) return;
  const lab = s.labels[c];
  app.pushUndo();
  if (s.regionOff[lab] === 1) {
    app.mask.exclude = app.mask.exclude.filter(([x, y]) => { const cc = s.cellOf(x, y); return cc < 0 || s.labels[cc] !== lab; });
  } else if (s.regionOff[lab] === 0) {
    app.mask.exclude.push([+w[0].toFixed(2), +w[1].toFixed(2)]);
  } else { toast(t("toast.regionTooSmall")); return; }
  recomputeMask();
};
$("regionReset").onclick = () => { app.pushUndo(); app.mask.exclude = []; recomputeMask(); };

// ------------------------------------------------------------------ tools
function setTool(tool) {
  editor.tool = tool;
  $("toolSelect").classList.toggle("active", tool === "select");
  $("toolDraw").classList.toggle("active", tool === "draw");
  $("toolRegion").classList.toggle("active", tool === "region");
  $("cv2d").style.cursor = tool === "select" ? "default" : "crosshair";
  editor.render();
}
$("toolSelect").onclick = () => setTool("select");
$("toolDraw").onclick = () => setTool("draw");
$("toolRegion").onclick = () => setTool(editor.tool === "region" ? "select" : "region");
$("fitBtn").onclick = () => editor.fit();
$("showLines").onchange = (e) => { app.showRealWidth = e.target.checked; editor.render(); };

app.ensureDrawElement = (w) => {
  let el = app.selected();
  if (!el || el.type !== "draw") {
    app.pushUndo();
    el = newElement("draw", w, app.lastSlot ?? 0);
    app.elements.push(el);
    app.selectedId = el.id;
    renderProps();
  }
  return el;
};

// ------------------------------------------------------------------ elements list
document.querySelectorAll("[data-add]").forEach(b => b.onclick = () => addElement(b.dataset.add));

function addElement(type, extra) {
  if (!app.surf) { toast(t("toast.loadFileFirst")); return; }
  app.pushUndo();
  const b = app.surf.maskBox;
  let ctr = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  if (!app.surf.inMask(ctr[0], ctr[1]) && app.surf.deep && type !== "pattern") ctr = app.surf.deep.slice();
  const el = newElement(type, ctr, app.lastSlot ?? 0);
  if (extra) Object.assign(el.props, extra);
  if (type === "pattern") el.props.frame = "surface";
  app.elements.push(el);
  app.selectedId = el.id;
  if (type === "draw") setTool("draw");
  app.changed(el);
  renderProps();
  if (type === "image" || type === "svg") setTimeout(() => document.querySelector("#props input[type=file]")?.click(), 50);
}

function renderList() {
  const ul = $("elList");
  ul.innerHTML = "";
  [...app.elements].reverse().forEach((el) => {
    const li = document.createElement("li");
    li.className = (el.id === app.selectedId ? "sel " : "") + (el.visible ? "" : "hid");
    const b = app.built.get(el.id);
    const n = b ? b.clipped.length : 0;
    const i = app.elements.indexOf(el);
    li.innerHTML = `<span class="sw" style="background:${app.slotColor(el.slot)}"></span><span class="nm">${esc(el.name)}</span><span class="ty">${n}</span>
      <button class="ord" title="${esc(t("el.up"))}"${i >= app.elements.length - 1 ? " disabled" : ""}>▲</button><button class="ord" title="${esc(t("el.down"))}"${i <= 0 ? " disabled" : ""}>▼</button>
      <button title="${esc(t("el.visible"))}">${el.visible ? "◉" : "○"}</button><button title="${esc(t("el.duplicate"))}">⧉</button><button title="${esc(t("el.delete"))}">✕</button>`;
    li.onclick = (e) => { if (e.target.tagName !== "BUTTON") { app.select(el.id); } };
    const [bUp, bDn, bVis, bDup, bDel] = li.querySelectorAll("button");
    const move = (d) => {
      const k = app.elements.indexOf(el), target = k + d;
      if (target < 0 || target >= app.elements.length) return;
      app.pushUndo();
      const arr = app.elements;
      [arr[k], arr[target]] = [arr[target], arr[k]];
      app.changed(el); renderList(); renderProps();
    };
    bUp.onclick = () => move(1);
    bDn.onclick = () => move(-1);
    bVis.onclick = () => { app.pushUndo(); el.visible = !el.visible; app.changed(el); };
    bDup.onclick = () => duplicate(el);
    bDel.onclick = () => removeEl(el);
    ul.appendChild(li);
  });
}

function duplicate(el) {
  app.pushUndo();
  const c = structuredClone(el);
  c.id = newElement(el.type, [0, 0], el.slot).id;
  c.name = el.name + " " + t("el.copy");
  if (app.hasTf(c)) { c.tf.x += 3; c.tf.y -= 3; }
  app.elements.push(c);
  app.selectedId = c.id;
  app.changed(c);
  renderProps();
}
function removeEl(el) {
  app.pushUndo();
  app.elements = app.elements.filter(e => e !== el);
  app.built.delete(el.id);
  if (app.selectedId === el.id) app.selectedId = null;
  afterChange();
  renderProps();
}

app.select = (id) => {
  if (app.selectedId === id) return;
  app.selectedId = id;
  renderList(); renderProps(); editor.render();
};

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ------------------------------------------------------------------ filaments
// Same order as printer.match_mapping: colour+type, then colour, then type.
function matchTray(f) {
  const norm = (c) => String(c || "").toUpperCase().replace("#", "").slice(0, 6);
  const col = norm(f.color), typ = String(f.type || "").toUpperCase();
  const tr = app.amsTrays || [];
  let m = tr.find(x => norm(x.color) === col && String(x.type).toUpperCase() === typ);
  if (m) return { t: m, exact: true };
  m = tr.find(x => norm(x.color) === col);
  if (m) return { t: m, exact: false, why: t("fil.matchColor", { t: m.type, f: f.type }) };
  m = tr.find(x => String(x.type).toUpperCase() === typ);
  if (m) return { t: m, exact: false, why: t("fil.matchType", { t: m.color, f: f.color }) };
  return null;
}

function renderFilaments() {
  const box = $("filList");
  box.innerHTML = "";
  for (const f of app.meta.filaments) {
    const d = document.createElement("div");
    d.className = "f";
    d.innerHTML = `<span class="sw" style="background:${f.color}"></span><b>${f.slot + 1}</b> ${esc(f.type)} <span class="t">${esc(f.name)} · ${f.temp}°C${f.used ? esc(t("fil.inPrint")) : ""}</span>`;
    if (app.amsTrays) {
      const m = matchTray(f);
      const a = document.createElement("span");
      a.className = "ams" + (m ? (m.exact ? "" : " warn") : " bad");
      a.title = m ? (m.exact ? t("fil.matchExact") : m.why) : t("fil.matchNone");
      a.innerHTML = m ? `${esc(t("fil.amsTarget", { n: m.t.slot + 1 }))} <span class="sw" style="background:${m.t.color}"></span>${esc(m.t.type)}${m.t.remain != null && m.t.remain >= 0 ? ` ${m.t.remain}%` : ""}${m.exact ? "" : " ⚠"}`
                      : esc(t("fil.notInAms"));
      d.appendChild(a);
    }
    box.appendChild(d);
  }
  const lf = app.meta.filaments[app.meta.last_filament];
  $("lastFil").innerHTML = lf ? `<span class="sw" style="background:${lf.color}"></span> ${lf.slot + 1} ${esc(lf.type)}` : "–";
}

// read the AMS and adopt its colours for the display (the G-code keeps the file's values)
async function syncAms() {
  const btn = $("amsSync");
  btn.disabled = true;
  try {
    const st = await (await api("/api/printer/status")).json();
    if (!st.connected) { toast(t("toast.printerOffline"), true); return; }
    const trays = st.trays || [];
    if (!trays.length) { toast(t("toast.noAms"), true); return; }
    app.amsTrays = trays;
    let n = 0;
    for (const f of app.meta.filaments) {
      const m = matchTray(f);
      if (!m) continue;
      const same = String(f.color).toUpperCase().replace("#", "") === String(m.t.color).toUpperCase().replace("#", "");
      if (!same) { f.color = m.t.color; n++; }
      f.ams = { slot: m.t.slot, type: m.t.type, exact: m.exact };
    }
    renderFilaments();
    for (const el of app.elements) app.changed(el, { live: true });
    editor.render();
    updateDesignStats();
    toast(n ? t("toast.amsSynced", { n }) : t("toast.amsSyncedSame"));
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}
$("amsSync").onclick = syncAms;

// ------------------------------------------------------------------ properties panel
const P = $("props");
function row(label, input, unit, tipText) {
  const r = document.createElement("div");
  r.className = "row";
  const l = document.createElement("label");
  const sp = document.createElement("span"); sp.textContent = label; l.append(sp);
  if (tipText) l.append(infoIcon(tipText));
  r.append(l, input);
  if (unit) { const u = document.createElement("span"); u.className = "unit"; u.textContent = unit; r.append(u); }
  return r;
}
function num(val, step, onchange, min, max) {
  const i = document.createElement("input");
  i.type = "number"; i.step = step; i.value = +(+val).toFixed(4);
  if (min !== undefined) i.min = min; if (max !== undefined) i.max = max;
  i.addEventListener("change", () => { const v = parseFloat(i.value); if (isFinite(v)) onchange(v); });
  return i;
}
function slider(val, min, max, step, onchange, fmt = (v) => v) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex:1;gap:6px;align-items:center";
  const i = document.createElement("input"); i.type = "range"; i.min = min; i.max = max; i.step = step; i.value = val;
  i.style.flex = "1";
  const v = document.createElement("span"); v.className = "val"; v.textContent = fmt(+val);
  let pushed = false;
  i.addEventListener("pointerdown", () => { app.pushUndo(); pushed = true; });
  i.addEventListener("input", () => { v.textContent = fmt(+i.value); onchange(+i.value, true); });
  i.addEventListener("change", () => { onchange(+i.value, false); pushed = false; });
  wrap.append(i, v);
  return wrap;
}
function check(val, label, onchange) {
  const l = document.createElement("label"); l.className = "chk";
  const i = document.createElement("input"); i.type = "checkbox"; i.checked = !!val;
  i.onchange = () => onchange(i.checked);
  const sp = document.createElement("span"); sp.textContent = label;
  l.append(i, sp);
  return l;
}
function seg(options, val, onchange) {
  const d = document.createElement("div"); d.className = "seg";
  for (const [k, lbl] of Object.entries(options)) {
    const b = document.createElement("button"); b.textContent = lbl; b.className = k === val ? "on" : "";
    b.onclick = () => { onchange(k); };
    d.appendChild(b);
  }
  return d;
}
function select(options, val, onchange) {
  const s = document.createElement("select");
  for (const [k, lbl] of Object.entries(options)) { const o = document.createElement("option"); o.value = k; o.textContent = lbl; s.appendChild(o); }
  s.value = val;
  s.onchange = () => onchange(s.value);
  return s;
}
function slotPicker(val, onchange, allowSkip = false) {
  const d = document.createElement("div"); d.className = "slotpick";
  if (allowSkip) {
    const b = document.createElement("button"); b.className = "skip" + (val < 0 ? " on" : ""); b.textContent = "–"; b.title = t("props.skip");
    b.onclick = () => onchange(-1); d.appendChild(b);
  }
  for (const f of app.meta.filaments) {
    const b = document.createElement("button");
    b.style.background = f.color; b.className = f.slot === val ? "on" : "";
    b.textContent = f.slot + 1; b.title = t("props.slotTitle", { n: f.slot + 1, type: f.type, name: f.name });
    const c = hexToRgb(f.color); if (c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11 < 110) b.style.color = "#fff";
    b.onclick = () => onchange(f.slot);
    d.appendChild(b);
  }
  return d;
}
function h4(text, tipText) {
  const h = document.createElement("h4");
  const sp = document.createElement("span"); sp.textContent = text; h.append(sp);
  if (tipText) h.append(infoIcon(tipText));
  return h;
}

function setProp(el, k, v, live = false) {
  if (!live && !app._propUndoPushed) app.pushUndo();
  el.props[k] = v;
  app.changed(el, { live });
}

let tfFields = null;
function syncTfFields() {
  const el = app.selected();
  if (!el || !tfFields) return;
  tfFields.x.value = el.tf.x.toFixed(2); tfFields.y.value = el.tf.y.toFixed(2);
  tfFields.rot.value = el.tf.rot.toFixed(1); tfFields.s.value = (el.tf.s * 100).toFixed(1);
}

function renderProps() {
  P.innerHTML = "";
  tfFields = null;
  const el = app.selected();
  if (!el || !app.meta) {
    P.innerHTML = `<p class="hint">${esc(t("props.empty"))}</p>`;
    renderList();
    return;
  }
  const nameI = document.createElement("input"); nameI.type = "text"; nameI.value = el.name;
  nameI.onchange = () => { el.name = nameI.value; renderList(); saveDesign(); };
  P.append(row(t("props.name"), nameI));
  if (el.type !== "image") {
    P.append(row(t("props.color"), slotPicker(el.slot, (s) => { app.pushUndo(); el.slot = s; app.lastSlot = s; app.changed(el); renderProps(); })));
  }
  const p = el.props;
  const typeTip = { outline: "tip.outline", pattern: "tip.patternEl", draw: "tip.drawEl" }[el.type];
  P.append(h4(t(TYPES[el.type].label).toUpperCase(), typeTip ? t(typeTip) : null));
  const sl = (label, k, min, max, step, unit = "mm", fmt, tipText) =>
    P.append(row(label, slider(p[k], min, max, step, (v, live) => setPropLive(el, k, v, live), fmt || ((v) => `${(+v).toFixed(step < 0.1 ? 2 : 1)} ${unit}`)), null, tipText));
  switch (el.type) {
    case "outline":
      P.append(row(t("props.source"), seg({ mask: t("props.sourceMask"), object: t("props.sourceObject") }, p.source, (v) => { setProp(el, "source", v); renderProps(); })));
      sl(t("props.offset"), "offset", 0, 10, 0.05);
      sl(t("props.count"), "count", 1, 30, 1, "", (v) => `${v}×`);
      sl(t("props.spacing"), "spacing", 0.2, 10, 0.05);
      sl(t("props.minLen"), "minLen", 0, 50, 0.5);
      marginControl(el, p, sl);
      break;
    case "pattern":
      P.append(row(t("props.pattern"), select(Object.fromEntries(Object.entries(PATTERNS).map(([k, v]) => [k, t(v)])), p.kind, (v) => { setProp(el, "kind", v); renderProps(); })));
      sl(t("props.spacing2"), "spacing", 0.3, 20, 0.05);
      if (["wave", "zigzag", "curls", "dots"].includes(p.kind)) sl(p.kind === "dots" ? t("props.radius") : t("props.amp"), "amp", 0.1, 10, 0.05);
      if (["wave", "zigzag", "curls"].includes(p.kind)) sl(t("props.wavelength"), "wavelength", 0.3, 30, 0.1);
      P.append(row(t("props.frame"), seg({ surface: t("props.frameSurface"), rect: t("props.frameRect"), ellipse: t("props.frameEllipse") }, p.frame, (v) => { setProp(el, "frame", v); renderProps(); })));
      if (p.frame !== "surface") {
        sl(t("props.width"), "w", 1, 200, 0.5);
        sl(t("props.height"), "h", 1, 200, 0.5);
        P.append(row("", check(p.border, t("props.border"), (v) => setProp(el, "border", v))));
      }
      marginControl(el, p, sl);
      break;
    case "draw": {
      sl(t("props.smooth"), "smooth", 0, 4, 1, "", (v) => `${v}`);
      const b1 = document.createElement("button"); b1.className = "btn small"; b1.textContent = t("btn.strokeUndo");
      b1.onclick = () => { app.pushUndo(); p.strokes.pop(); app.changed(el); };
      const b2 = document.createElement("button"); b2.className = "btn small ghost"; b2.textContent = t("btn.strokeClear");
      b2.onclick = () => { app.pushUndo(); p.strokes = []; app.changed(el); };
      const r = document.createElement("div"); r.className = "row tools"; r.append(b1, b2); P.append(r);
      marginControl(el, p, sl);
      break;
    }
    case "image": {
      P.append(fileRow(t("props.imageFile"), "image/*", (data, name) => { setProp(el, "src", data); p.name = name; el.name = name.replace(/\.[^.]+$/, ""); p.map = []; renderProps(); renderList(); }, p.name));
      sl(t("props.width"), "w", 1, 200, 0.5);
      rasterControls(el, p, sl);
      sl(t("props.colors"), "colors", 1, 6, 1, "", (v) => `${v}`);
      const r = rasterOf(el);
      if (r) {
        P.append(h4(t("props.colorsToFilament")));
        r.colors.forEach((hex, c) => {
          const d = document.createElement("div"); d.className = "cluster";
          const sw = document.createElement("span"); sw.className = "cw"; sw.style.background = hex;
          d.append(sw, slotPicker(p.map[c] ?? -1, (s) => { app.pushUndo(); p.map[c] = s; if (s >= 0) app.lastSlot = s; app.changed(el); renderProps(); }, true));
          P.append(d);
        });
      }
      fillControls(el, p, sl);
      sl(t("props.smooth"), "smooth", 0, 4, 1, "", (v) => `${v}`);
      P.append(row("", check(p.despeckle, t("props.despeckle"), (v) => setProp(el, "despeckle", v))));
      marginControl(el, p, sl);
      break;
    }
    case "text": {
      const ta = document.createElement("textarea"); ta.value = p.text;
      ta.oninput = () => { app._propUndoPushed = true; setProp(el, "text", ta.value, true); };
      ta.onfocus = () => app.pushUndo();
      ta.onchange = () => { app._propUndoPushed = false; setProp(el, "text", ta.value); app._propUndoPushed = false; };
      P.append(row(t("props.text"), ta));
      const fonts = { "sans-serif": "Sans", "serif": "Serif", "monospace": "Mono", "DejaVu Sans": "DejaVu Sans", "Noto Sans": "Noto Sans",
        "Liberation Serif": "Liberation Serif", "Inter": "Inter", "Impact": "Impact", "cursive": t("font.script") };
      const fs = select(fonts, fonts[p.font] ? p.font : "sans-serif", (v) => setProp(el, "font", v));
      P.append(row(t("props.font"), fs));
      const fi = document.createElement("input"); fi.type = "text"; fi.placeholder = t("props.customFont"); fi.value = fonts[p.font] ? "" : p.font;
      fi.onchange = () => { if (fi.value.trim()) setProp(el, "font", fi.value.trim()); };
      P.append(row("", fi));
      P.append(row(t("props.weight"), seg({ "300": "Light", "400": "Normal", "700": "Bold", "900": "Black" }, p.weight, (v) => { setProp(el, "weight", v); renderProps(); })));
      P.append(row("", check(p.italic, t("props.italic"), (v) => setProp(el, "italic", v))));
      sl(t("props.size"), "size", 1, 40, 0.5);
      rasterControls(el, p, sl);
      if ((p.tile | 0) > 0) sl(t("props.areaWidth"), "w", 5, 200, 0.5);
      fillControls(el, p, sl);
      marginControl(el, p, sl);
      break;
    }
    case "svg":
      P.append(fileRow(t("props.svgFile"), ".svg,image/svg+xml", (data, name) => { setProp(el, "src", data); p.name = name; el.name = name.replace(/\.[^.]+$/, ""); renderProps(); renderList(); }, p.name, true));
      sl(t("props.width"), "w", 1, 200, 0.5);
      P.append(row("", check(p.stroke, t("props.strokes"), (v) => setProp(el, "stroke", v))));
      P.append(row("", check(p.fill, t("props.fill"), (v) => { setProp(el, "fill", v); renderProps(); })));
      if (p.fill) { sl(t("props.fillSpacing"), "spacing", 0.2, 5, 0.01); sl(t("props.fillAngle"), "angle", -90, 90, 1, "°", (v) => `${v}°`); }
      marginControl(el, p, sl);
      break;
  }
  const b = app.built.get(el.id);
  if (b?.info) { const h = hint(b.info); h.classList.add("built-info"); P.append(h); }
  renderList();
}

function marginControl(el, p, sl) {
  P.append(h4(t("props.marginH"), t("tip.margin")));
  P.append(row(t("props.margin"), slider(p.margin || 0, 0, 15, 0.05, (v) => setPropLive(el, "margin", v, true), (v) => `${(+v).toFixed(2)} mm`)));
  P.append(h4(t("props.splineH"), t("tip.smoothing")));
  P.append(row(t("props.strength"), slider(p.smoothStrength || 0, 0, 1, 0.05, (v, live) => setPropLive(el, "smoothStrength", v, live), (v) => (+v).toFixed(2))));
  P.append(row(t("props.iterations"), slider(p.smoothIter || 0, 0, 20, 1, (v, live) => setPropLive(el, "smoothIter", v, live), (v) => `${v}×`)));
}

function rasterControls(el, p, sl) {
  P.append(row(t("props.frame"), seg({ rect: t("props.frameRect"), surface: t("props.frameSurface") }, p.frame || "rect",
    (v) => { setProp(el, "frame", v); renderProps(); })));
  sl(t("props.heightAuto"), "h", 0, 200, 0.5);
  sl(t("props.tile"), "tile", 0, 100, 0.5, "mm", null, t("tip.tile"));
  P.append(h4(t("props.cropH"), t("tip.crop")));
  const cr = Array.isArray(p.crop) && p.crop.length === 4 ? p.crop : [0, 0, 1, 1];
  const cf = (idx) => num(Math.round(cr[idx] * 100), 1, (v) => {
    const q = [...cr];
    q[idx] = Math.max(0, Math.min(1, (isFinite(v) ? v : 0) / 100));
    setProp(el, "crop", q);
  });
  const r1 = row(t("props.cropXY"), cf(0), "%"); r1.append(cf(1)); P.append(r1);
  const r2 = row(t("props.cropWH"), cf(2), "%"); r2.append(cf(3)); P.append(r2);
  const rb = document.createElement("button"); rb.className = "btn small ghost"; rb.textContent = t("btn.wholeMotif");
  rb.onclick = () => { setProp(el, "crop", [0, 0, 1, 1]); renderProps(); };
  P.append(rb);
}

function fillControls(el, p, sl) {
  P.append(row("", check(p.contour, t("props.strokes"), (v) => setProp(el, "contour", v))));
  P.append(row("", check(p.fill, t("props.fill"), (v) => { setProp(el, "fill", v); renderProps(); })));
  if (p.fill) {
    sl(t("props.fillSpacing"), "spacing", 0.2, 5, 0.01);
    sl(t("props.fillAngle"), "angle", -90, 90, 1, "°", (v) => `${v}°`);
  }
}

function setPropLive(el, k, v, live) {
  app._propUndoPushed = true;   // slider pushes undo on pointerdown
  el.props[k] = v;
  app.changed(el, { live });
  app._propUndoPushed = false;
}

function hint(txt) { const p = document.createElement("p"); p.className = "hint"; p.textContent = txt; return p; }

function fileRow(label, accept, onload, name, asText = false) {
  const l = document.createElement("label"); l.className = "btn small";
  l.textContent = name ? t("btn.otherFile") : t("btn.chooseFile");
  const i = document.createElement("input"); i.type = "file"; i.accept = accept; i.hidden = true;
  i.onchange = () => {
    const f = i.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => onload(rd.result, f.name);
    asText ? rd.readAsText(f) : rd.readAsDataURL(f);
  };
  l.append(i);
  const r = row(label, l);
  if (name) { const s = document.createElement("span"); s.className = "unit"; s.textContent = name; r.append(s); }
  return r;
}

// ------------------------------------------------------------------ params panel
function renderParams() {
  const main = $("params"), adv = $("paramsAdv");
  main.innerHTML = ""; adv.innerHTML = "";
  for (const [k, labelKey, min, max, step, unit, f, isMain, tipKey] of PARAM_UI) {
    const v = app.params[k];
    const r = row(t(labelKey), slider(v * f, min * f, max * f, step * f, (x, live) => {
      app.params[k] = x / f;
      markStale(); updateDesignStats();
      if (k === "line_width" || k === "z_offset") { if (k === "line_width") rebuildAll(); clearTimeout(d3T); d3T = setTimeout(update3dDesign, 200); editor.render(); }
      if (!live) saveDesign();
    }, (x) => `${(+x).toFixed(step * f < 0.1 ? 2 : step * f < 1 ? 1 : 0)} ${unit}`), null, tipKey ? t(tipKey) : null);
    (isMain ? main : adv).append(r);
  }
  for (const [k, labelKey, tipKey] of PARAM_BOOL) {
    const r = row("", check(app.params[k], t(labelKey), (v) => { app.params[k] = v; markStale(); saveDesign(); }), null, t(tipKey));
    adv.append(r);
  }
  const pi = $("printInfo");
  if (pi && app.meta) pi.dataset.tip = t("params.info", { line: app.meta.insert_line });
}

// ------------------------------------------------------------------ printer
let pStatusT = null;
async function loadPrinter() {
  try {
    const p = await (await api("/api/printer")).json();
    $("pIp").value = p.ip || "";
    $("pCode").value = "";
    $("pCode").placeholder = p.has_code ? t("ph.accessCodeStored") : t("ph.accessCode");
    $("pStart").checked = !!p.start_after_send;
    if (p.serial) $("pInfo").textContent = t("printer.serial", { sn: p.serial });
  } catch {}
}

function pInfo(txt, err) { const el = $("pInfo"); el.textContent = txt; el.style.color = err ? "var(--bad)" : "var(--dim)"; }

async function savePrinter() {
  const body = { ip: $("pIp").value.trim(), code: $("pCode").value.trim(), start_after_send: $("pStart").checked };
  const p = await (await api("/api/printer", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  $("pCode").value = "";
  $("pCode").placeholder = p.has_code ? t("ph.accessCodeStored") : t("ph.accessCode");
  return p;
}

$("pSave").onclick = async () => { try { await savePrinter(); pInfo(t("printer.saved")); toast(t("toast.printerSaved")); } catch (e) { pInfo(e.message, true); } };
$("pStart").onchange = async () => { try { await savePrinter(); } catch {} };
$("pFind").onclick = async () => {
  pInfo(t("printer.searching"));
  try {
    const r = await (await api("/api/printer/discover")).json();
    if (!r.found.length) { pInfo(t("printer.noneFound"), true); return; }
    $("pIp").value = r.found[0].ip;
    pInfo(t("printer.found", { ips: r.found.map(f => f.ip).join(", ") }));
  } catch (e) { pInfo(e.message, true); }
};
$("pTest").onclick = async () => {
  pInfo(t("printer.testing"));
  try {
    const body = JSON.stringify({ ip: $("pIp").value.trim(), code: $("pCode").value.trim() });
    const r = await (await api("/api/printer/test", { method: "POST", headers: { "Content-Type": "application/json" }, body })).json();
    await loadPrinter();
    const st = r.printer || {};
    pInfo(t("printer.ok", {
      pwd: r.pwd, ms: r.ms,
      serial: r.serial ? ` · SN ${r.serial}` : "",
      state: st.state ? ` · ${st.state} ${st.percent ?? ""}%` : "",
    }));
    if (r.serial) savePrinter();
  } catch (e) { pInfo(e.message, true); }
};

function pollPrinter() {
  clearInterval(pStatusT);
  pStatusT = setInterval(async () => {
    if (!app.fid) return;
    try {
      const st = await (await api("/api/printer/status")).json();
      if (st.connected) {
        const layers = st.layers ? ` · ${getLang() === "de" ? "Layer" : "layer"} ${st.layer}/${st.layers}` : "";
        const ams = (st.trays || []).map(x => `${x.slot + 1}:${x.type} ${x.color}`).join("  ");
        pInfo(t("printer.live", { state: st.state || "?", percent: st.percent != null ? st.percent + "%" : "", layers, file: st.file ? " · " + st.file : "" }) +
              (ams ? `\n${t("printer.liveAms", { ams })}` : ""));
        // An empty answer is a missing report, not an empty AMS: keep the last known trays.
        if (st.trays && st.trays.length) {
          const key = JSON.stringify(st.trays);
          if (key !== app.amsKey) { app.amsKey = key; app.amsTrays = st.trays; if (app.meta) renderFilaments(); }
        }
      }
    } catch {}
  }, 5000);
}

async function sendToPrinter() {
  if (!app.fid) { toast(t("toast.loadFileFirst")); return; }
  if (!allDesignLines().length) { toast(t("toast.noLines")); return; }
  const start = $("pStart").checked;
  if (!app.gen || app.genStale || genPromise) {
    pInfo(t("status.generatingShort"));
    const pr = generate();
    if (pr) await pr;
  }
  if (!app.gen || app.genStale) { pInfo(t("status.genFailed"), true); return; }
  $("sendBtn").disabled = true;
  pInfo(start ? t("status.sendingStart") : t("status.sending"));
  try {
    const r = await (await api(`/api/job/${app.fid}/send?plate=${app.plate}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start }),
    })).json();
    const notes = (r.mapping_notes || []).join(" · ");
    const msg = t("printer.uploaded", { name: r.name, size: (r.upload.size / 1e6).toFixed(1) }) +
      (notes ? `\n${notes}` : "") +
      (r.started ? `\n${t("printer.startSent")}` : "") + (r.warning ? `\n${r.warning}` : "");
    pInfo(msg, !!r.warning);
    toast(r.started ? t("toast.sentStarted") : t("toast.sentManual"));
    if (r.started) setTimeout(async () => {
      try {
        const st = await (await api("/api/printer/status")).json();
        if (st.connected) pInfo(`${msg}\n${t("printer.live", { state: st.state, percent: `${st.percent ?? 0}%`, layers: "", file: st.file ? " · " + st.file : "" })}`, !!r.warning);
      } catch {}
    }, 4000);
  } catch (e) {
    pInfo(e.message, true); toast(e.message, true);
  } finally {
    $("sendBtn").disabled = false;
  }
}
$("sendBtn").onclick = sendToPrinter;

// ------------------------------------------------------------------ generate & export
let genPromise = null;
function generate() {
  if (genPromise) return genPromise;              // one generation at a time
  genPromise = _generate().finally(() => { genPromise = null; });
  return genPromise;
}

async function _generate() {
  if (!app.fid) return;
  const lines = allDesignLines();
  if (!lines.length) { toast(t("toast.noLines")); return; }
  status(t("status.generating"));
  app.genStale = true;                            // nothing valid until the response arrives
  $("genBtn").disabled = true;
  try {
    const paths = lines.map(l => ({ slot: l.slot, closed: !!l.closed, order: l.order | 0, pts: l.pts.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]) }));
    const res = await (await api(`/api/job/${app.fid}/generate?plate=${app.plate}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params: app.params, paths, head: app.head || undefined }),
    })).json();
    const bin = atob(res.moves);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    res.movesArr = new Float32Array(u8.buffer);
    res.flagsArr = res.flags ? Uint8Array.from(atob(res.flags), ch => ch.charCodeAt(0)) : null;
    res.codeLines = res.gcode.split("\n");
    app.gen = res; app.genStale = false;
    $("exp3mf").disabled = $("expGcode").disabled = false;
    $("sendBtn").disabled = false;
    renderGenStats();
    showTab("3d");
    v3.clear("design");
    v3.setGcode(res.movesArr, app.params.line_width, $("v3Travel").checked, res.flagsArr, res.retracts,
      { down: $("v3Down").checked, retr: $("v3Retr").checked, touches: res.touches || [] });
    showCollisions(res.collisions);
    v3.setCuts(res.stats.cuts);
    v3.show("cuts", $("v3Cuts").checked);
    editor.render();
    const n = res.movesArr.length / 9;
    const sl = $("playSlider"); sl.max = n; sl.value = n;
    $("playbar").classList.remove("hidden");
    $("codeView").classList.toggle("hidden", !$("v3Code").checked);
    updatePlay(n);
    status(t("status.generated", { lines: res.lines, time: fmtTime(res.stats.time_s) }), "ok");
    saveDesign();
  } catch (e) {
    status(e.message, "err"); toast(e.message, true);
    app.genStale = true;
  } finally { $("genBtn").disabled = false; }
}
$("genBtn").onclick = generate;

async function exportFile(fmt) {
  if (!app.gen || app.genStale) await generate();
  if (!app.gen || app.genStale) return;
  const a = document.createElement("a");
  a.href = `/api/job/${app.fid}/export?plate=${app.plate}&fmt=${fmt}`;
  a.download = "";
  document.body.appendChild(a); a.click(); a.remove();
  toast(t("toast.exportStarted"));
}
$("exp3mf").onclick = () => exportFile("3mf");
$("expGcode").onclick = () => exportFile("gcode");

// playback
let playing = false;
function updatePlay(i) {
  v3.setPlay(i);
  const g = app.gen;
  if (!g) return;
  const n = g.movesArr.length / 9;
  let line = 0;
  if (i > 0) line = g.movesArr[(i - 1) * 9 + 8] | 0;
  $("playInfo").textContent = t("play.line", { i, n, line: line + 1 });
  if (!$("codeView").classList.contains("hidden")) {
    const a = Math.max(0, line - 14), b = Math.min(g.codeLines.length, line + 30);
    let html = "";
    for (let k = a; k < b; k++) html += `<div class="ln${k === line ? " cur" : ""}${g.codeLines[k].startsWith("; impasto") ? " impasto" : ""}"><span class="no">${k + 1}</span>${esc(g.codeLines[k])}</div>`;
    $("codeView").innerHTML = html;
  }
}
$("playSlider").oninput = (e) => { playing = false; $("playBtn").textContent = "▶"; updatePlay(+e.target.value); };
$("playBtn").onclick = () => {
  const sl = $("playSlider");
  playing = !playing;
  $("playBtn").textContent = playing ? "❚❚" : "▶";
  if (playing && +sl.value >= +sl.max) sl.value = 0;
  const tick = () => {
    if (!playing) return;
    const n = +sl.max;
    const v = Math.min(n, +sl.value + Math.max(1, Math.round(n / 600)));
    sl.value = v; updatePlay(v);
    if (v >= n) { playing = false; $("playBtn").textContent = "▶"; return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

// ------------------------------------------------------------------ tabs + 3d toggles
function showTab(tab) {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $("view2d").classList.toggle("hidden", tab !== "2d");
  $("view3d").classList.toggle("hidden", tab !== "3d");
  $("tools2d").classList.toggle("hidden", tab !== "2d");
  $("tools3d").classList.toggle("hidden", tab !== "3d");
  v3.setVisible(tab === "3d");
  if (tab === "3d") update3dDesign();
  else editor.resize();
}
document.querySelectorAll(".tab").forEach(b => b.onclick = () => showTab(b.dataset.tab));
$("v3Surface").onchange = (e) => v3.show("surface", e.target.checked);
$("v3Orig").onchange = (e) => { v3.show("orig", e.target.checked); if (e.target.checked) loadOriginal(); };
$("v3Travel").onchange = (e) => v3.show("travel", e.target.checked);
$("v3Code").onchange = (e) => { $("codeView").classList.toggle("hidden", !e.target.checked || !app.gen || app.genStale); updatePlay(+$("playSlider").value); };
$("v3Zmin").onchange = () => loadOriginal();
$("v3Xray").onchange = (e) => v3.setXray(e.target.checked);
$("v3Coll").onchange = (e) => v3.show("coll", e.target.checked);
$("v3Cuts").onchange = (e) => v3.show("cuts", e.target.checked);
$("v3Down").onchange = (e) => v3.setDown(e.target.checked);
$("v3Retr").onchange = (e) => v3.show("retr", e.target.checked);
$("v3Top").onclick = () => v3.top();
$("v3Iso").onclick = () => v3.home();

// ------------------------------------------------------------------ file controls
$("fileInput").onchange = (e) => { const f = e.target.files[0]; if (f) upload(f); e.target.value = ""; };
$("fileSel").onchange = (e) => { const f = app.files.find(x => x.id === e.target.value); openFile(e.target.value, f?.plates?.[0] || 1); };
$("plateSel").onchange = (e) => openFile(app.fid, +e.target.value);
$("delFile").onclick = async () => {
  if (!app.fid || !confirm(t("confirm.deleteFile"))) return;
  await api(`/api/files/${app.fid}`, { method: "DELETE" });
  app.fid = null;
  await refreshFiles();
  if (app.files.length) openFile(app.files[0].id, app.files[0].plates[0]);
};
const v2 = $("view2d");
v2.addEventListener("dragover", (e) => { e.preventDefault(); $("dropHint").classList.remove("hidden"); $("dropHint").classList.add("over"); });
v2.addEventListener("dragleave", () => { $("dropHint").classList.remove("over"); if (app.surf) $("dropHint").classList.add("hidden"); });
v2.addEventListener("drop", (e) => {
  e.preventDefault();
  $("dropHint").classList.remove("over");
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name) && app.surf) { readAsElement(f, "image"); return; }
  if (/\.svg$/i.test(f.name) && app.surf) { readAsElement(f, "svg"); return; }
  upload(f);
});
function readAsElement(f, type) {
  const rd = new FileReader();
  rd.onload = () => {
    addElement(type, { src: rd.result, name: f.name });
    const el = app.selected(); el.name = f.name.replace(/\.[^.]+$/, ""); renderList(); renderProps();
  };
  type === "svg" ? rd.readAsText(f) : rd.readAsDataURL(f);
}

// ------------------------------------------------------------------ keyboard
window.addEventListener("keydown", (e) => {
  const tag = e.target;
  if (tag && (tag.tagName === "INPUT" || tag.tagName === "TEXTAREA" || tag.tagName === "SELECT")) return;
  const el = app.selected();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") { e.preventDefault(); if (el) duplicate(el); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case "v": case "V": setTool("select"); break;
    case "d": case "D": setTool("draw"); break;
    case "r": case "R": setTool(editor.tool === "region" ? "select" : "region"); break;
    case "f": case "F": editor.fit(); break;
    case "g": case "G": generate(); break;
    case "s": case "S": if (app.gen && !app.genStale) sendToPrinter(); break;
    case "Escape": app.select(null); setTool("select"); break;
    case "Delete": case "Backspace": if (el) { e.preventDefault(); removeEl(el); } break;
    case "ArrowLeft": case "ArrowRight": case "ArrowUp": case "ArrowDown":
      if (el && app.hasTf(el)) {
        e.preventDefault();
        const d = e.shiftKey ? 1 : 0.1;
        app.pushUndo();
        if (e.key === "ArrowLeft") el.tf.x -= d; if (e.key === "ArrowRight") el.tf.x += d;
        if (e.key === "ArrowUp") el.tf.y += d; if (e.key === "ArrowDown") el.tf.y -= d;
        app.changed(el);
      }
      break;
  }
});
window.addEventListener("beforeunload", () => { if (app.fid) navigator.sendBeacon && saveDesign(); });

// ------------------------------------------------------------------ language
function markLangButtons() {
  for (const b of document.querySelectorAll(".langsel button")) b.classList.toggle("on", b.dataset.lang === getLang());
}
document.querySelectorAll(".langsel button").forEach(b => b.onclick = () => setLang(b.dataset.lang));
onLang(() => {
  markLangButtons();
  loadHeads();
  loadPrinter();
  if (!app.meta) { updateDesignStats(); return; }
  renderFilaments(); renderParams(); renderProps(); renderList(); updateDesignStats();
  refreshVariants();
  maskInfo();
  if (editor.tool === "region") editor.render();
});

// ------------------------------------------------------------------ start
initLang();
initTips();
applyStatic();
markLangButtons();
updateDesignStats();
(async function init() {
  loadPrinter();
  pollPrinter();
  try {
    await Promise.all([refreshFiles(), loadHeads()]);
    let last = null;
    try { last = JSON.parse(localStorage.getItem("impasto.last") || localStorage.getItem("npg.last") || "null"); } catch {}
    const f = (last && app.files.find(x => x.id === last.fid)) || app.files[0];
    if (f) {
      $("fileSel").value = f.id;
      await openFile(f.id, last && last.fid === f.id ? last.plate : f.plates[0]);
    } else status(t("status.loadHint"));
  } catch (e) { status(e.message, "err"); }
})();
