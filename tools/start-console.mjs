import { pathToFileURL, fileURLToPath } from 'node:url';
import { certificateCommand } from '../src/platform/certificates.mjs';
import { inspectCaptureRecovery, recoverCapture } from '../src/capture.mjs';

export async function startConsole(args = process.argv.slice(2), dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const print = dependencies.print ?? console.log;
  const command = String(args[0] ?? '').toLowerCase();
  env.CW_PORT ||= '17323';
  if (command === 'url' || command === 'address') {
    print(`http://127.0.0.1:${env.CW_PORT}/`);
    const hold = dependencies.hold ?? (() => new Promise(() => { setInterval(() => {}, 60_000); }));
    await hold();
    return;
  }
  if (command === 'status' || command === 'check') {
    await (dependencies.certificateCommand ?? certificateCommand)(['status']);
    const recovery = (dependencies.inspectCaptureRecovery ?? inspectCaptureRecovery)();
    if (recovery.pending) print(recovery.error || recovery.message);
    return;
  }
  if (command === 'recover') {
    const result = await (dependencies.recoverCapture ?? recoverCapture)();
    print(result.pending ? result.error || result.message : '采集改动已清理。');
    return;
  }
  env.CW_NO_BROWSER = '1';
  env.CW_QUIET_START = '1';
  const launch = dependencies.launch ?? (async () => {
    process.argv = [process.argv[0], fileURLToPath(new URL('../src/app.mjs', import.meta.url)), 'console'];
    await import('../src/app.mjs');
  });
  await launch();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startConsole().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
