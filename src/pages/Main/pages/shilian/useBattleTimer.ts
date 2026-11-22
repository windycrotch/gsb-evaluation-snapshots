import { useCallback, useEffect, useRef } from 'react';

type TimerId = ReturnType<typeof setTimeout>;

/**
 * 战斗定时器管理
 *
 * - combatTimer：战斗回合推进 interval
 * - guajiTimer：挂机调度 interval
 * - autoBattleTimer：自动开战 timeout
 * - managedTimeouts：所有需要跟随会话/组件生命周期清理的 timeout
 *   （例如战后延迟清理妖兽实例、挂机锁释放等）。
 * 过期会话的回调一律在调用方用会话标识拦截，这里负责保证组件卸载后
 * 不再有任何残留定时器触发。
 */
export default function useBattleTimer() {
  const timer = useRef<TimerId | null>(null);
  const guajiTimer = useRef<TimerId | null>(null);
  const autoBattleTimer = useRef<TimerId | null>(null);
  const managedTimeouts = useRef<Set<TimerId>>(new Set());

  const clearCombatTimer = useCallback(() => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const clearGuajiTimer = useCallback(() => {
    if (guajiTimer.current !== null) {
      clearInterval(guajiTimer.current);
      guajiTimer.current = null;
    }
  }, []);

  const clearAutoBattleTimer = useCallback(() => {
    if (autoBattleTimer.current !== null) {
      clearTimeout(autoBattleTimer.current);
      autoBattleTimer.current = null;
    }
  }, []);

  /**
   * 注册一个受托管的 timeout。返回取消函数，调用方可在会话失效时
   * 主动取消；组件卸载时所有未触发的 timeout 都会被统一清理。
   */
  const setManagedTimeout = useCallback((fn: () => void, delay: number) => {
    const id = setTimeout(() => {
      managedTimeouts.current.delete(id);
      fn();
    }, delay) as TimerId;
    managedTimeouts.current.add(id);
    return () => {
      if (managedTimeouts.current.delete(id)) {
        clearTimeout(id);
      }
    };
  }, []);

  const clearManagedTimeouts = useCallback(() => {
    managedTimeouts.current.forEach((id) => clearTimeout(id));
    managedTimeouts.current.clear();
  }, []);

  const setCombatTimer = useCallback(
    (fn: () => void, interval: number) => {
      clearCombatTimer();
      timer.current = setInterval(fn, interval);
    },
    [clearCombatTimer]
  );

  const setGuajiTimer = useCallback(
    (fn: () => void, interval: number) => {
      clearGuajiTimer();
      guajiTimer.current = setInterval(fn, interval);
    },
    [clearGuajiTimer]
  );

  const setAutoBattleTimer = useCallback(
    (fn: () => void, delay: number) => {
      clearAutoBattleTimer();
      autoBattleTimer.current = setTimeout(fn, delay) as TimerId;
    },
    [clearAutoBattleTimer]
  );

  const clearAll = useCallback(() => {
    clearCombatTimer();
    clearGuajiTimer();
    clearAutoBattleTimer();
    clearManagedTimeouts();
  }, [
    clearCombatTimer,
    clearGuajiTimer,
    clearAutoBattleTimer,
    clearManagedTimeouts
  ]);

  useEffect(() => clearAll, [clearAll]);

  return {
    setCombatTimer,
    setGuajiTimer,
    setAutoBattleTimer,
    setManagedTimeout,
    clearCombatTimer,
    clearGuajiTimer,
    clearAutoBattleTimer,
    clearManagedTimeouts,
    clearAll
  };
}
