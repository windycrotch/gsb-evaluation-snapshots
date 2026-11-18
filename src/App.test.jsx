import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import App from './App.jsx';

// Canvas 2D context is unavailable in jsdom and the particle burst is
// irrelevant to the progression logic under test.
vi.mock('./components/ParticleCanvas', () => ({
  ParticleCanvas: () => <div data-testid="particle-canvas-mock" />,
}));

// Web Audio is not implemented in jsdom either.
vi.mock('./utils/audio', () => ({
  audioSynth: {
    playWaterSound: vi.fn(),
    playGrowSound: vi.fn(),
    playFanfareSound: vi.fn(),
  },
}));

const GROW_DELAY = 350;
const MODAL_DELAY = 400;

const getButton = () =>
  screen.getByRole('button', { name: /regar|otro poquito|está creciendo|floreció/i });

const clickWater = () => fireEvent.click(getButton());

// Fire a valid click and flush the 350 ms growth delay.
const waterAndWait = () => {
  clickWater();
  act(() => {
    vi.advanceTimersByTime(GROW_DELAY);
  });
};

const visibleLeafCount = () =>
  // PlantSvg renders one <g> per leaf node; hidden leaves carry opacity 0.
  document.querySelectorAll('#leavesGroup > g').length
    ? [...document.querySelectorAll('#leavesGroup > g')].filter(
        (g) => g.style.opacity !== '0'
      ).length
    : 0;

const reasonCount = () => document.querySelectorAll('.reason-item').length;

const initialAppearance = () => ({
  stage: document.querySelector('.plant-stem').getAttribute('height'),
  leaves: visibleLeafCount(),
  reasons: reasonCount(),
  titleVisible: !!document.querySelector('.main-title.visible'),
  specialVisible: !!document.querySelector('.special-phrase.visible'),
  drops: document.querySelectorAll('.water-drops-container').length,
  ripple: document.querySelectorAll('.splash-ripple').length,
  modal: !!document.querySelector('.modal-backdrop'),
  bloom: !!document.querySelector('.sunflower-bloom-wrapper.blooming'),
  buttonText: getButton().textContent,
});

describe('Riego: lógica de avance por etapas', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
  });

  it('avanza una sola etapa por clic válido, con hojas, razones y texto del botón de la misma etapa', () => {
    render(<App />);

    // Etapa 0 inicial: sin título, hojas, razones ni gotas.
    expect(visibleLeafCount()).toBe(0);
    expect(reasonCount()).toBe(0);
    expect(document.querySelector('.main-title.visible')).toBeNull();
    expect(getButton()).toHaveTextContent('Regar con amor');

    // Etapa 1
    waterAndWait();
    expect(visibleLeafCount()).toBe(1);
    expect(reasonCount()).toBe(1);
    expect(document.querySelector('.main-title.visible')).not.toBeNull();
    expect(getButton()).toHaveTextContent('Otro poquito');

    // Etapa 2
    waterAndWait();
    expect(visibleLeafCount()).toBe(2);
    expect(reasonCount()).toBe(2);
    expect(document.querySelector('.plant-stem').getAttribute('height')).toBe('110');
    expect(getButton()).toHaveTextContent('Está creciendo');

    // Etapa 3: el tallo crece pero NO aparece una hoja nueva (sigue en 2),
    // en cambio sí aparece la tercera razón.
    waterAndWait();
    expect(visibleLeafCount()).toBe(2);
    expect(reasonCount()).toBe(3);
    expect(document.querySelector('.plant-stem').getAttribute('height')).toBe('170');

    // Etapa 4
    waterAndWait();
    expect(visibleLeafCount()).toBe(3);
    expect(reasonCount()).toBe(4);

    // Etapa 5
    waterAndWait();
    expect(visibleLeafCount()).toBe(4);
    expect(reasonCount()).toBe(5);
    expect(document.querySelector('.special-phrase.visible')).not.toBeNull();
    expect(document.querySelector('.modal-backdrop')).toBeNull();

    // El 5º riego abre la tarjeta final tras 400 ms en vez de seguir creciendo.
    clickWater();
    act(() => {
      vi.advanceTimersByTime(MODAL_DELAY);
    });
    expect(document.querySelector('.modal-backdrop')).not.toBeNull();
    expect(visibleLeafCount()).toBe(4);
    expect(reasonCount()).toBe(5);
  });

  it('ignora los clics rápidos durante el retardo: solo avanza una etapa y el botón se deshabilita', () => {
    render(<App />);

    clickWater();
    // Mientras el retardo de 350 ms está en vuelo el botón está deshabilitado.
    expect(getButton()).toBeDisabled();

    // Ráfaga de clics repetidos (incl. clics sintéticos que no respetan el
    // atributo `disabled`): ninguno debe encolar un salto de etapa.
    for (let i = 0; i < 5; i++) {
      clickWater();
    }

    act(() => {
      vi.advanceTimersByTime(GROW_DELAY);
    });

    // Una sola etapa efectiva pese a los 6 clics.
    expect(visibleLeafCount()).toBe(1);
    expect(reasonCount()).toBe(1);
    expect(getButton()).toBeEnabled();

    // Tras el retardo, un nuevo clic vuelve a avanzar exactamente una etapa.
    waterAndWait();
    expect(visibleLeafCount()).toBe(2);
    expect(reasonCount()).toBe(2);
  });

  it('la tarjeta abre la flor ("Floreció") y un clic devuelve la apariencia inicial exacta', () => {
    render(<App />);
    const firstAppearance = initialAppearance();

    for (let i = 0; i < 5; i++) waterAndWait();

    // 5º riego: tarjeta final.
    clickWater();
    act(() => {
      vi.advanceTimersByTime(MODAL_DELAY);
    });
    expect(document.querySelector('.modal-backdrop')).not.toBeNull();

    // "Ver la flor de mi amor" -> floración.
    fireEvent.click(
      screen.getByRole('button', { name: /ver la flor de mi amor/i })
    );
    expect(document.querySelector('.modal-backdrop')).toBeNull();
    expect(document.querySelector('.sunflower-bloom-wrapper.blooming')).not.toBeNull();
    expect(getButton()).toHaveTextContent('Floreció');

    // Clic en estado de floración: vuelta a la etapa inicial.
    clickWater();
    expect(initialAppearance()).toEqual(firstAppearance);
    expect(getButton()).toHaveTextContent('Regar con amor');
    expect(document.querySelector('.sunflower-bloom-wrapper.blooming')).toBeNull();
  });

  it('los callbacks retardados encolados antes del reset no vuelven a cambiar la etapa', () => {
    render(<App />);
    const firstAppearance = initialAppearance();

    // Avanza hasta la etapa 4.
    for (let i = 0; i < 4; i++) waterAndWait();
    expect(visibleLeafCount()).toBe(3);

    // Clic que deja el retardo de 350 ms pendiente (etapa 4 -> 5 en vuelo).
    clickWater();
    expect(getButton()).toBeDisabled();

    // Sin esperar al retardo, entra en floración por el camino de la tarjeta:
    // se libera el bloqueo y queda un callback de crecimiento "viejo" en cola.
    act(() => {
      vi.advanceTimersByTime(GROW_DELAY);
    });
    clickWater(); // etapa 5 -> tarjeta (400 ms)
    act(() => {
      vi.advanceTimersByTime(MODAL_DELAY);
    });
    fireEvent.click(
      screen.getByRole('button', { name: /ver la flor de mi amor/i })
    );
    expect(document.querySelector('.sunflower-bloom-wrapper.blooming')).not.toBeNull();

    // El riego en floración resetea; el callback de crecimiento capturó la
    // etapa 5 con un token ya invalidado.
    clickWater();
    expect(initialAppearance()).toEqual(firstAppearance);

    // Dispara cualquier temporizador que hubiera quedado encolado: nada debe
    // mover la planta de su estado inicial.
    act(() => {
      vi.runAllTimers();
    });
    expect(initialAppearance()).toEqual(firstAppearance);
    expect(visibleLeafCount()).toBe(0);
    expect(reasonCount()).toBe(0);
  });
});
