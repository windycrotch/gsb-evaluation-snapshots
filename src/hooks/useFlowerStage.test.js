import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useFlowerStage,
  STAGE_ADVANCE_DELAY,
  MODAL_REVEAL_DELAY,
} from './useFlowerStage.js';

vi.mock('../utils/audio', () => ({
  audioSynth: {
    playWaterSound: vi.fn(),
    playGrowSound: vi.fn(),
    playFanfareSound: vi.fn(),
  },
}));

describe('useFlowerStage: protección contra callbacks vencidos', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const reachStageFiveAndBloom = (result) => {
    // Etapas 0 -> 5.
    for (let i = 0; i < 5; i++) {
      act(() => result.current.handleWater());
      act(() => vi.advanceTimersByTime(STAGE_ADVANCE_DELAY));
    }
    // 5º riego: tarjeta final.
    act(() => result.current.handleWater());
    act(() => vi.advanceTimersByTime(MODAL_REVEAL_DELAY));
    // Floración.
    act(() => result.current.handleRevealFlower());
    expect(result.current.bloomSunflower).toBe(true);
    // Reset a la etapa inicial.
    act(() => result.current.handleWater());
    expect(result.current.currentStage).toBe(0);
  };

  it('un callback de crecimiento capturado antes del reset no aplica el salto de etapa al ejecutarse tarde (token guard)', () => {
    const { result } = renderHook(() => useFlowerStage());

    // Avanza hasta la etapa 4.
    for (let i = 0; i < 4; i++) {
      act(() => result.current.handleWater());
      act(() => vi.advanceTimersByTime(STAGE_ADVANCE_DELAY));
    }
    expect(result.current.currentStage).toBe(4);

    // Espía sin reemplazar: captura los callbacks pero el temporizador
    // simulado sigue funcionando con normalidad.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    act(() => result.current.handleWater()); // riego 4 -> 5 en vuelo

    // El callback de crecimiento (delay 350) capturado con el token viejo.
    const growCall = setTimeoutSpy.mock.calls.find(
      ([, delay]) => delay === STAGE_ADVANCE_DELAY
    );
    expect(growCall).toBeDefined();
    const staleGrowCallback = growCall[0];

    // Sigue el flujo completo: etapa 5, tarjeta, floración y reset.
    act(() => vi.advanceTimersByTime(STAGE_ADVANCE_DELAY));
    reachStageFiveAndBloom(result);

    // Apariencia inicial tras el reset.
    expect(result.current.currentStage).toBe(0);
    expect(result.current.bloomSunflower).toBe(false);
    expect(result.current.showModal).toBe(false);
    expect(result.current.dropsKey).toBe(0);
    expect(result.current.showRipple).toBe(false);

    // Ejecuta tarde el callback de crecimiento "zombi": el token guard
    // debe ignorarlo y la planta permanece en la etapa inicial.
    act(() => staleGrowCallback());
    expect(result.current.currentStage).toBe(0);
    expect(result.current.bloomSunflower).toBe(false);
    expect(result.current.showModal).toBe(false);
  });

  it('si la cancelación de temporizadores fallara, los timers encolados previos al reset tampoco mutan el estado', () => {
    const { result } = renderHook(() => useFlowerStage());

    reachStageFiveAndBloom(result);
    expect(result.current.currentStage).toBe(0);

    // Neutraliza la cancelación: cualquier timer que hubiera sobrevivido al
    // reset solo puede ser bloqueado por el token.
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});

    // Repite el ciclo de floración/reset: ahora clearAllTimers es un no-op.
    for (let i = 0; i < 5; i++) {
      act(() => result.current.handleWater());
      act(() => vi.advanceTimersByTime(STAGE_ADVANCE_DELAY));
    }
    act(() => result.current.handleWater());
    act(() => vi.advanceTimersByTime(MODAL_REVEAL_DELAY));
    act(() => result.current.handleRevealFlower());
    act(() => result.current.handleWater());

    expect(result.current.currentStage).toBe(0);
    expect(result.current.dropsKey).toBe(0);
    expect(result.current.showRipple).toBe(false);

    // Restaura clearTimeout y dispara todos los temporizadores viejos.
    vi.restoreAllMocks();
    act(() => vi.runAllTimers());

    expect(result.current.currentStage).toBe(0);
    expect(result.current.bloomSunflower).toBe(false);
    expect(result.current.showModal).toBe(false);
    expect(result.current.dropsKey).toBe(0);
    expect(result.current.showRipple).toBe(false);
  });
});
