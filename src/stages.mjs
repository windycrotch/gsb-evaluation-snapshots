import { setTimeout as sleep } from 'node:timers/promises';
import { waitForChallenge } from './battle-pacing.mjs';

export function stageFailureLimit(value = 3) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('失败次数需要填写正整数');
  return count;
}

export async function runStages(client, player, config, {
  maxFailures = 3, maxWins = Infinity, allowMutate = false, onStep = () => {}, onBattle = () => {},
  signal, wait = sleep, beforeBattle, schedule = work => work(),
  executeBattle = work => work(), enabled = () => true, onLineupPhase,
} = {}) {
  maxFailures = stageFailureLimit(maxFailures);
  let stage = player?.mainlineStage;
  if (!Number.isInteger(stage) || stage < 1 || !Number.isInteger(player?.level) || player.level < 1) {
    throw new Error('登录响应缺少有效的主线关卡或角色等级');
  }
  const rows = config?.tables?.StageCfg?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error('缺少 StageCfg，无法核对关卡等级要求');
  let wins = 0;
  let failures = 0;
  for (;;) {
    signal?.throwIfAborted();
    if (!enabled() || client.connected === false) throw new Error('账号状态已变化，主线推关已停止');
    if (wins >= maxWins) return { wins, reachedLimit: true, reason: `本次已通过 ${wins} 关` };
    const row = rows.find((entry) => entry.stage === stage);
    if (!row || !Number.isInteger(row.playerLevel)) return { wins, reason: `配置表中没有第 ${stage} 关的等级要求` };
    if (player.level < row.playerLevel) return { wins, reason: `第 ${stage} 关需要角色等级 ${row.playerLevel}，本次登录等级 ${player.level}` };
    if (!allowMutate) return { wins, reason: `可从第 ${stage} 关开始，同一关连续失败 ${maxFailures} 次停止。预览结束` };
    signal?.throwIfAborted();
    const won = await schedule(async () => {
      signal?.throwIfAborted();
      if (!enabled() || client.connected === false) throw new Error('账号状态已变化，主线推关已停止');
      return executeBattle(async () => {
        try {
          await waitForChallenge(client, { signal, wait, beforeSend: async () => {
            if (!enabled() || client.connected === false) throw new Error('账号状态已变化，未发送主线挑战');
            await beforeBattle?.(signal);
            signal?.throwIfAborted();
            if (!enabled() || client.connected === false) throw new Error('账号状态已变化，未发送主线挑战');
          } });
          signal?.throwIfAborted();
          if (!enabled() || client.connected === false) throw new Error('账号状态已变化，未发送主线挑战');
        } catch (error) {
          error.notSent = true;
          throw error;
        }
        const result = await client.request('ChallengeStageRequest', { stage }, 'ChallengeStageResponse');
        if (result?.initialData?.mainlineStage !== stage || typeof result?.stats?.isLeftWin !== 'boolean') {
          throw new Error(`第 ${stage} 关战报缺失或关卡不符，已停止`);
        }
        const won = result.stats.isLeftWin;
        if (won) {
          onStep(stage);
          wins++;
          failures = 0;
        } else failures++;
        // 战果在恢复阵容前确认，恢复失败仍保留实际进度和连败计数。
        onBattle({ stage, won, wins, failures });
        return won;
      }, { mode: 'mainline', stage, signal, enabled, onLineupPhase });
    });
    if (!won) {
      if (failures >= maxFailures) return { wins, reason: `第 ${stage} 关连续战败 ${failures} 次，已停止` };
      continue;
    }
    stage++;
  }
}

// One background run per console account. The stop signal cancels the delay;
// an already submitted battle is settled before another run can start.
export function createStageTask() {
  let controller = null;
  let state = { running: false, stopping: false, wins: 0, failures: 0, stage: null, reason: '尚未开启',
    lineupPhase: 'idle', lineupRestorePending: false };
  const view = () => ({ ...state });
  return {
    view,
    lineupRestored() {
      if (state.lineupRestorePending) {
        state.lineupPhase = 'idle';
        state.lineupRestorePending = false;
        state.reason = '阵容核对已完成，请重新开始挑战';
      }
      return view();
    },
    start({ maxFailures }, open, onError) {
      if (controller) throw new Error('这个账号已经开启了主线推关');
      maxFailures = stageFailureLimit(maxFailures);
      controller = new AbortController();
      const { signal } = controller;
      state = { running: true, stopping: false, maxFailures, stage: null, wins: 0, failures: 0, reason: '正在准备',
        lineupPhase: 'idle', lineupRestorePending: false };
      (async () => {
        try {
          const { client, player, config, beforeBattle, schedule, executeBattle, enabled, wait } = await open();
          state.stage = player?.mainlineStage;
          state.reason = '挑战中';
          const result = await runStages(client, player, config, {
            allowMutate: true, signal, maxFailures, beforeBattle, schedule, executeBattle, enabled, wait,
            onLineupPhase({ phase }) {
              state.lineupPhase = phase;
              state.lineupRestorePending = phase === 'pending' || phase === 'conflict';
            },
            onBattle({ stage, won, wins, failures }) {
              if (won) player.mainlineStage = stage + 1;
              Object.assign(state, { stage: player.mainlineStage, wins, failures, reason: won ? `第 ${stage} 关胜利` : `第 ${stage} 关战败` });
            },
          });
          state.reason = result.reason;
        } catch (error) {
          state.reason = error.message;
          if (error.lineupRestorePending) {
            state.reason = error.lineupRecovery?.reason || error.lineupRestoreError?.message || error.message;
            state.lineupRestorePending = true;
            if (state.lineupPhase !== 'conflict') state.lineupPhase = 'pending';
          }
          if (!signal.aborted || state.lineupRestorePending) onError?.(error);
        } finally {
          if (signal.aborted && !state.lineupRestorePending) state.reason = signal.reason.message;
          controller = null;
          state.running = state.stopping = false;
        }
      })();
      return view();
    },
    stop(reason = '已手动停止') {
      if (controller) {
        state.stopping = true;
        controller.abort(new Error(reason));
      }
      return view();
    },
  };
}
