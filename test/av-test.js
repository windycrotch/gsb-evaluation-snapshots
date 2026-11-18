// A timestamped capture source, never shipped as a content script.
const canvas = document.getElementById('signal');
const pen = canvas.getContext('2d');
let context, origin = null;
function draw() {
  const elapsed = origin !== null ? Math.floor((context.currentTime - origin) * 1000) : 0;
  pen.fillStyle = '#182033'; pen.fillRect(0, 0, 1280, 640);
  for (let i = 0; i < 32; i++) {
    pen.fillStyle = (elapsed >>> i) & 1 ? '#fff' : '#000';
    pen.fillRect(i * 40, 0, 40, 80);
  }
  pen.fillStyle = '#fff'; pen.font = '72px monospace'; pen.fillText(`${(elapsed / 1000).toFixed(3)} 秒`, 140, 280);
  pen.font = '32px system-ui'; pen.fillText('当前源时间 · 每秒闪光与 880 Hz 短音', 140, 400);
  pen.fillStyle = elapsed % 1000 < 120 ? '#fff' : '#2769d3'; pen.fillRect(1000, 220, 140, 140);
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
document.getElementById('start').addEventListener('click', async () => {
  if (context) return;
  context = new AudioContext(); await context.resume();
  const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < context.sampleRate * 0.12; i++) data[i] = 0.2 * Math.sin(2 * Math.PI * 880 * i / context.sampleRate) * Math.min(1, i / 240, (context.sampleRate * 0.12 - i) / 240);
  const source = context.createBufferSource(); source.buffer = buffer; source.loop = true; source.connect(context.destination);
  origin = context.currentTime; source.start(origin);
  document.getElementById('start').disabled = true;
  document.getElementById('info').textContent = '正在输出；捕获此标签页，比较播放页中的源时间与当前源时间。';
});
