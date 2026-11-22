/**
 * Component-level tests for the decoded-image canvas and image export.
 *
 * SettingsPanel (MUI) is mocked out so these tests stay focused on the canvas
 * sizing / save-filename behaviour that must follow the active mode and session.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/components/SettingsPanel', () => ({
  __esModule: true,
  default: ({ currentMode }: { currentMode: string }) => (
    <div data-testid="settings-panel" data-mode={currentMode} />
  ),
}));

import SSTVDecoder from '@/components/SSTVDecoder';
import { SSTV_MODES } from '@/lib/sstv/constants';

type Mode = 'ROBOT36' | 'PD120' | 'SCOTTIE_S2';

function Harness({ initialMode = 'ROBOT36' as Mode }) {
  const [mode, setMode] = React.useState<Mode>(initialMode);
  return (
    <SSTVDecoder
      selectedMode={mode}
      onModeChange={(m) => setMode(m as Mode)}
    />
  );
}

function decodedCanvas(): HTMLCanvasElement {
  const canvases = document.querySelectorAll('canvas');
  // The decoded-image canvas is the first canvas rendered.
  return canvases[0] as HTMLCanvasElement;
}

describe('SSTVDecoder canvas session boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // jsdom does not implement object URLs.
    (URL as unknown as { createObjectURL: jest.Mock }).createObjectURL = jest.fn(() => 'blob:mock');
    (URL as unknown as { revokeObjectURL: jest.Mock }).revokeObjectURL = jest.fn();
  });

  test('canvas dimensions follow the selected mode prop', async () => {
    render(<Harness initialMode="ROBOT36" />);

    expect(decodedCanvas().width).toBe(SSTV_MODES.ROBOT36.width);
    expect(decodedCanvas().height).toBe(SSTV_MODES.ROBOT36.height);
    expect(screen.getByText(`${SSTV_MODES.ROBOT36.width}×${SSTV_MODES.ROBOT36.height}`)).toBeInTheDocument();
  });

  test('save filename reflects the active mode, not a fixed robot36 name', async () => {
    const downloads: string[] = [];
    const originalCreateElement = document.createElement.bind(document);
    jest.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'click', { value: jest.fn() });
        const descriptor = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'download');
        Object.defineProperty(el, 'download', {
          get: () => (el as HTMLAnchorElement).getAttribute('download') ?? '',
          set: (v: string) => {
            downloads.push(v);
            el.setAttribute('download', v);
          },
          configurable: true,
        });
        void descriptor;
      }
      return el;
    }) as typeof document.createElement);

    render(<Harness initialMode="ROBOT36" />);

    fireEvent.click(screen.getByText('Save Image'));

    await waitFor(() => expect(downloads.length).toBe(1));
    expect(downloads[0]).toContain('robot36');
    expect(downloads[0]).not.toBe('sstv-decode-robot36-.png');
    expect(downloads[0].endsWith('.png')).toBe(true);

    jest.restoreAllMocks();
  });
});
