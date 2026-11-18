const $ = id => document.getElementById(id);
const PERIOD = 8;
const FIRST = 2;
const PATTERN = 16;
let context;
let source;
let startedAt = 0;
let lastIndex = -1;
let frame;
let wallOrigin = 0;

for (let id = 1; id <= PATTERN; id++) {
  const option = document.createElement("option"); option.value = id; option.textContent = `#${id}`; $("heard-id").append(option);
}

function format(seconds) {
  const ms = Math.floor(Math.max(0, seconds) * 1000);
  return `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
function log(id, text) {
  const li = document.createElement("li"); li.textContent = text; $(id).prepend(li);
  while ($(id).children.length > 24) $(id).lastChild.remove();
}
function addTone(data, rate, time, duration, frequency, level) {
  const start = Math.round(time * rate);
  const length = Math.round(duration * rate);
  for (let i = 0; i < length; i++) {
    const envelope = Math.min(1, i / (rate * 0.005), (length - i) / (rate * 0.005));
    data[(start + i) % data.length] += level * envelope * Math.sin(2 * Math.PI * frequency * i / rate);
  }
}
async function start() {
  $("source-start").disabled = true;
  try {
    context = new AudioContext();
    await context.resume();
    const buffer = context.createBuffer(1, Math.round(PERIOD * PATTERN * context.sampleRate), context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < PATTERN; index++) {
      addTone(data, context.sampleRate, index * PERIOD, 0.09, 880, 0.35);
      for (let code = 0; code <= index; code++) addTone(data, context.sampleRate, index * PERIOD + 0.25 + code * 0.12, 0.045, 1320, 0.15);
    }
    source = context.createBufferSource(); source.buffer = buffer; source.loop = true; source.connect(context.destination);
    startedAt = context.currentTime;
    wallOrigin = Date.now();
    source.start(startedAt + FIRST);
    lastIndex = -1; $("source-log").replaceChildren(); $("heard-log").replaceChildren();
    $("source-stop").disabled = false; $("mark-heard").disabled = false;
    $("source-info").textContent = `源已运行，${context.sampleRate} Hz；第一声在启动后 2 秒。后台循环音不依赖 JS 定时器。`;
    update();
  } catch (error) {
    $("source-info").textContent = error.message;
    await stop();
  }
}
function update() {
  if (!context) return;
  const elapsed = context.currentTime - startedAt;
  $("clock").textContent = format(elapsed);
  const index = Math.floor((elapsed - FIRST) / PERIOD);
  if (index >= 0) {
    const pulseTime = FIRST + index * PERIOD;
    $("pulse").textContent = `#${index % PATTERN + 1}`;
    $("pulse").classList.toggle("flash", elapsed - pulseTime < 0.25);
    if (index !== lastIndex) {
      log("source-log", `#${index % PATTERN + 1} · 输入 ${format(pulseTime)} · ${new Date(wallOrigin + pulseTime * 1000).toLocaleTimeString("zh-CN", { hour12: false })}`);
      lastIndex = index;
    }
  }
  frame = requestAnimationFrame(update);
}
async function stop() {
  cancelAnimationFrame(frame);
  source?.stop(); source?.disconnect(); source = null;
  if (context) await context.close(); context = null;
  $("source-start").disabled = false; $("source-stop").disabled = true; $("mark-heard").disabled = true;
  $("pulse").classList.remove("flash");
}
$("mark-heard").addEventListener("click", () => {
  const elapsed = context.currentTime - startedAt;
  const id = Number($("heard-id").value);
  const latestIndex = Math.floor((elapsed - FIRST) / PERIOD);
  const index = latestIndex - ((latestIndex - (id - 1)) % PATTERN + PATTERN) % PATTERN;
  if (index < 0) { $("measurement").textContent = "该编号尚未发出，请选择听到的声音编号。"; return; }
  const inputTime = FIRST + index * PERIOD;
  const measured = elapsed - inputTime;
  const result = `#${id} · 输入 ${format(inputTime)} → 听到 ${format(elapsed)} · 人工测量 ${measured.toFixed(3)} 秒`;
  $("measurement").textContent = result; log("heard-log", result);
  $("heard-id").value = id % PATTERN + 1;
});
$("source-start").addEventListener("click", () => void start());
$("source-stop").addEventListener("click", () => void stop());
window.addEventListener("pagehide", () => { void stop(); });
