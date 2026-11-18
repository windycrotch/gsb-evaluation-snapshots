import { setTimeout as sleep } from 'node:timers/promises';
import { toNumber } from './client.mjs';
import { runStages } from './stages.mjs';

export const maxStagesPerRound = 3;
const RETRY_POWER_RATIO = 1.03;
const RETRY_AFTER_SECONDS = 6 * 3600;

const stageLabel = '主线自动推图';
const stageLosses = new WeakMap();

export function stageRetryWait(loss, player, now) {
  if (!loss || loss.stage !== player?.mainlineStage) return null;
  const power = toNumber(player?.power);
  if (loss.power > 0 && Number.isFinite(power) && power >= loss.power * RETRY_POWER_RATIO) return null;
  if (now >= loss.at + RETRY_AFTER_SECONDS) return null;
  return loss.at + RETRY_AFTER_SECONDS;
}

export async function serviceStageAuto(client, config, { player, enabled = () => false, report = () => {}, scheduler,
  isBusy = () => false, wait = sleep, executeBattle = work => work() } = {}) {
  const key = 'stageAuto';
  const finish = entry => { report({ key, label: stageLabel, ...entry }); };
  const later = seconds => scheduler?.defer(key, scheduler.now() + seconds);
  if (!enabled()) return;
  if (isBusy()) { later(60); return finish({ skipped: true, reason: '手动推关进行中' }); }
  const now = Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
  const retryAt = stageRetryWait(stageLosses.get(client), player, now);
  if (retryAt) {
    later(300);
    return finish({ skipped: true, reason: '第 ' + player.mainlineStage + ' 关上次战败，等待战力上涨 3% 或 6 小时后重试' });
  }
  const passed = [];
  try {
    const result = await runStages(client, player, config, {
      allowMutate: true, maxFailures: 1, maxWins: maxStagesPerRound, wait, executeBattle,
      enabled: () => enabled() && !isBusy(),
      onBattle({ stage, won }) {
        if (won) {
          player.mainlineStage = stage + 1;
          passed.push(stage);
          stageLosses.delete(client);
        } else stageLosses.set(client, { stage, power: toNumber(player.power) || 0, at: now });
      },
    });
    const lost = stageLosses.get(client);
    if (passed.length) finish({ ok: true, label: stageLabel + ' · 通过第 ' + passed.join('、') + ' 关' });
    if (lost) {
      later(300);
      return finish({ ok: true, label: stageLabel + ' · 第 ' + lost.stage + ' 关战败，等待战力上涨后重试' });
    }
    if (passed.length && result.reachedLimit) { later(30); return; }
    later(600);
    finish({ skipped: true, reason: result.reason });
  } catch (error) {
    later(600);
    finish({ ok: false, error: error.message });
  }
}
