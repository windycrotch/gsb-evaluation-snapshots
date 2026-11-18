import { DelayGraph } from "../audio-graph.js";

const SAMPLE_RATE = 8000;
const INPUT_TIME = 0.25;
const results = [];
window.audioTestResults = results;

function assert(condition, message) { if (!condition) throw new Error(message); }
function record(scenario, target, measured, pass, detail = "") {
  const row = { scenario, target, measured, pass, detail }; results.push(row);
  const tr = document.createElement("tr");
  for (const value of [scenario, target.toFixed(1) + " s", measured?.toFixed(4) + " s", pass ? "通过" : "失败 " + detail]) {
    const td = document.createElement("td"); td.textContent = value; tr.append(td);
  }
  document.getElementById("results").append(tr);
}
function impulse(context, times) {
  const buffer = context.createBuffer(1, context.length, SAMPLE_RATE);
  times.forEach(time => { buffer.getChannelData(0)[Math.round(time * SAMPLE_RATE)] = 1; });
  const source = context.createBufferSource(); source.buffer = buffer; source.start(); return source;
}
async function staticCase(delay) {
  const context = new OfflineAudioContext(1, Math.ceil((delay + 0.75) * SAMPLE_RATE), SAMPLE_RATE);
  const graph = new DelayGraph(context, impulse(context, [INPUT_TIME]), delay);
  const buffer = await context.startRendering(); const output = buffer.getChannelData(0);
  const index = output.findIndex(value => Math.abs(value) > 0.5);
  const measured = index / SAMPLE_RATE - INPUT_TIME;
  let count = 0; for (const value of output) if (Math.abs(value) > 0.5) count++;
  const pass = index >= 0 && Math.abs(measured - delay) <= 1 / SAMPLE_RATE && count === 1;
  record("固定脉冲延迟 / 无原声", delay, measured, pass, `输出脉冲数 ${count}`);
  graph.disconnect();
}
export async function dynamicCase(next) {
  // Include the pulse at input 5 s + delay 3 s, plus its trailing sample.
  const context = new OfflineAudioContext(1, 9 * SAMPLE_RATE, SAMPLE_RATE);
  const graph = new DelayGraph(context, impulse(context, [0.25, 5]), 1);
  const suspended = context.suspend(2);
  const rendering = context.startRendering();
  await suspended; graph.setDelay(next); await context.resume();
  const output = (await rendering).getChannelData(0);
  const secondIndex = output.findIndex((value, index) => index > 4 * SAMPLE_RATE && Math.abs(value) > 0.5);
  const measured = secondIndex / SAMPLE_RATE - 5;
  record("运行中调整后脉冲", next, measured, secondIndex >= 0 && Math.abs(measured - next) <= 1 / SAMPLE_RATE);
  graph.disconnect();
}
async function stopCase() {
  const context = new OfflineAudioContext(1, 4 * SAMPLE_RATE, SAMPLE_RATE);
  const graph = new DelayGraph(context, impulse(context, [0.25, 2]), 1);
  const suspended = context.suspend(2.5);
  const rendering = context.startRendering();
  await suspended; graph.disconnect(); await context.resume();
  const output = (await rendering).getChannelData(0);
  assert(output.slice(3 * SAMPLE_RATE).every(value => value === 0), "停止后仍有延迟尾音");
  record("停止后尾音已清除", 0, 0, true);
}

async function pitchCase() {
  const context = new OfflineAudioContext(1, 7 * SAMPLE_RATE, SAMPLE_RATE);
  const source = context.createBufferSource();
  const buffer = context.createBuffer(1, context.length, SAMPLE_RATE);
  const frequency = 437;
  const input = buffer.getChannelData(0);
  for (let i = 0; i < input.length; i++) input[i] = 0.5 * Math.sin(2 * Math.PI * frequency * i / SAMPLE_RATE);
  source.buffer = buffer; source.start();
  const graph = new DelayGraph(context, source, 1);
  const first = context.suspend(2), second = context.suspend(4);
  const rendering = context.startRendering();
  await first;
  const pauseStart = context.currentTime;
  graph.setDelay(1.5);
  await context.resume();
  await second;
  graph.setDelay(1);
  await context.resume();
  const output = (await rendering).getChannelData(0);
  const silent = output.slice(Math.ceil((pauseStart + 0.025) * SAMPLE_RATE), Math.floor((pauseStart + 0.535) * SAMPLE_RATE));
  assert(silent.every(value => Math.abs(value) < 1e-6), "增加延迟期间存在非静音输出");
  function measuredFrequency(start, end) {
    const crossings = [];
    for (let i = Math.ceil(start * SAMPLE_RATE); i < end * SAMPLE_RATE; i++) {
      if (output[i - 1] <= 0 && output[i] > 0) crossings.push((i - 1 + -output[i - 1] / (output[i] - output[i - 1])) / SAMPLE_RATE);
    }
    return (crossings.length - 1) / (crossings.at(-1) - crossings[0]);
  }
  const frequencies = [[1.3, 1.8], [3, 3.5], [5, 5.5]].map(([start, end]) => measuredFrequency(start, end));
  assert(frequencies.every(value => Math.abs(value - frequency) < 0.1), `调节改变了音高：${frequencies}`);
  const firstAudible = output.findIndex((value, index) => index > (pauseStart + 0.3) * SAMPLE_RATE && Math.abs(value) > 0.05) / SAMPLE_RATE;
  window.pitchTestResult = { inputHz: frequency, measuredHz: frequencies, pauseUntilResumeSeconds: firstAudible - pauseStart, silentSamples: silent.length, pass: true };
  record("增加暂停 / 减少跳转，音高不变", 0.5, firstAudible - pauseStart, true, `${frequencies.map(value => value.toFixed(3)).join(" / ")} Hz`);
  graph.disconnect();
}
async function run() {
  document.getElementById("run").disabled = true;
  results.length = 0; document.getElementById("results").replaceChildren();
  document.getElementById("summary").textContent = "正在渲染音频信号…";
  try {
    if (new URLSearchParams(location.search).get("cases") !== "adjustments") {
      for (const delay of [0, 1, 10, 30, 60]) await staticCase(delay);
      await stopCase();
    }
    await dynamicCase(1.5); await dynamicCase(3); await pitchCase();
    document.getElementById("summary").textContent = `${results.filter(row => row.pass).length}/${results.length} 项通过 · 采样率 ${SAMPLE_RATE} Hz · 分辨率 ${1 / SAMPLE_RATE} 秒`;
    document.body.dataset.result = results.every(row => row.pass) ? "passed" : "failed";
  } catch (error) { document.getElementById("summary").textContent = error.stack; document.body.dataset.result = "failed"; }
  finally { document.getElementById("run").disabled = false; }
}
document.getElementById("run").addEventListener("click", () => void run());
if (new URLSearchParams(location.search).has("autorun")) void run();
