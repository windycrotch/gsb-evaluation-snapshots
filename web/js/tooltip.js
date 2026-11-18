// Hover info: one shared tooltip for every element carrying data-tip.
// Explanations live here instead of standing next to the controls.

let box = null;
let timer = 0;
let hideTimer = 0;
let current = null;

function ensure() {
  if (box) return box;
  box = document.createElement("div");
  box.id = "tipbox";
  box.className = "tipbox hidden";
  document.body.appendChild(box);
  return box;
}

export function hideTip() {
  clearTimeout(timer);
  clearTimeout(hideTimer);
  current = null;
  if (box) box.classList.add("hidden");
}

function place(el) {
  const b = box;
  b.style.left = "0px";
  b.style.top = "0px";
  const r = el.getBoundingClientRect();
  const bw = b.offsetWidth, bh = b.offsetHeight;
  const pad = 8;
  let left = Math.min(Math.max(pad, r.left + r.width / 2 - bw / 2), window.innerWidth - bw - pad);
  let top = r.bottom + 7;
  if (top + bh > window.innerHeight - pad) top = r.top - bh - 7;
  b.style.left = `${Math.round(left)}px`;
  b.style.top = `${Math.round(Math.max(pad, top))}px`;
}

export function showTip(el) {
  const text = el?.dataset?.tip;
  if (!text) return;
  clearTimeout(hideTimer);
  clearTimeout(timer);
  current = el;
  ensure().textContent = text;
  box.classList.remove("hidden");
  place(el);
}

function schedule(el) {
  clearTimeout(timer);
  timer = setTimeout(() => showTip(el), 120);
}

export function initTips() {
  ensure();
  document.addEventListener("pointerover", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (!el) return;
    if (el === current && !box.classList.contains("hidden")) return;
    schedule(el);
  }, true);
  document.addEventListener("pointerout", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (!el) return;
    const to = e.relatedTarget;
    if (to && to.closest && to.closest("[data-tip]") === el) return;
    hideTip();
  }, true);
  document.addEventListener("focusin", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (el) showTip(el);
  });
  document.addEventListener("focusout", hideTip);
  document.addEventListener("pointerdown", hideTip, true);
  window.addEventListener("scroll", hideTip, true);
  window.addEventListener("resize", hideTip);
  window.addEventListener("langchange", hideTip);
}

