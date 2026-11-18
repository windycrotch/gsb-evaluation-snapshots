import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Converter from './Converter';
import { batchDownloadSTL, getFilamentPresets, getFilamentPreview, getFilamentSet, processImage, simulatePrintPreview } from '../api/client';
import { startParamSearch } from '../api/paramSearch';
import { filamentCatalog } from '../test/filamentCatalog';

vi.mock('../hooks/useBackendReady', () => ({ useBackendReady: () => true }));
vi.mock('../api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api/client')>(),
  getFilamentPresets: vi.fn(),
  getFilamentPreview: vi.fn(),
  getFilamentSet: vi.fn(),
  batchDownloadSTL: vi.fn(),
  processImage: vi.fn(),
  simulatePrintPreview: vi.fn(),
}));
vi.mock('../api/paramSearch', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api/paramSearch')>(),
  startParamSearch: vi.fn(),
  isParamSearchAvailable: vi.fn().mockResolvedValue(true),
}));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(getFilamentPresets).mockResolvedValue(structuredClone(filamentCatalog));
  vi.mocked(getFilamentPreview).mockResolvedValue({
    image: '', colorMatrix: [], stats: { colorCount: 5, combinationCount: 625 },
    imageDimensions: { width: 1, height: 1 }, warnings: [],
  });
  vi.mocked(batchDownloadSTL).mockResolvedValue(undefined);
  vi.mocked(batchDownloadSTL).mockClear();
  vi.mocked(getFilamentSet).mockResolvedValue({ maxLayerCount: 10, defaultBackingFilament: 'W' });
  vi.mocked(startParamSearch).mockClear();
  vi.mocked(processImage).mockResolvedValue({
    colorBlocks: [{ r: 255, g: 0, b: 0, hex: '#FF0000', count: 48 }],
    labelMap: btoa('\0'.repeat(48)),
    processedImage: 'data:image/png;base64,mock',
    segmentationImage: 'data:image/png;base64,seg',
    mappedBlockColors: [],
    mappedBlendPalette: [],
    imageDimensions: { width: 8, height: 6 },
    printStack: { opticalLayerCount: 4, whiteBackingLayers: 3, backingFilament: 'W', totalLayerCount: 7, totalHeightMm: 0.56 },
  });
  vi.mocked(simulatePrintPreview).mockResolvedValue({
    processedImage: 'data:image/png;base64,sim',
    mappedBlockColors: [],
    mappedBlendPalette: [],
    printStack: { opticalLayerCount: 4, whiteBackingLayers: 3, backingFilament: 'W', totalLayerCount: 7, totalHeightMm: 0.56 },
  });
});

/** Single-image flow through the mocked pipeline: file -> editor -> processed. */
async function processOneImage() {
  const picker = document.querySelector('input[type="file"][accept^="image/png"]:not([multiple])') as HTMLInputElement;
  const file = new File(['image'], 'sample.png', { type: 'image/png' });
  fireEvent.change(picker, { target: { files: [file] } });
  const applyButton = await screen.findByRole('button', { name: /Apply & Process/ });
  await act(async () => { fireEvent.click(applyButton); });
  await screen.findByRole('heading', { name: /Color Blocks \(1\)/ });
}

// The single-image upload path decodes through `new Image()`; jsdom never
// fires onload for data URLs, so auto-load in a microtask instead.
const OriginalImage = globalThis.Image;

beforeEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => ({ drawImage: vi.fn() })),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value: (callback: BlobCallback) => callback(new Blob(['x'], { type: 'image/png' })),
  });
  globalThis.Image = class {
    onload: ((this: GlobalEventHandlers, ev: Event) => unknown) | null = null;
    onerror: ((this: GlobalEventHandlers, ev: Event | string) => unknown) | null = null;
    width = 8;
    height = 6;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.call(this as unknown as GlobalEventHandlers, new Event('load')));
    }
  } as unknown as typeof Image;
});

afterEach(() => {
  globalThis.Image = OriginalImage;
});

describe('converter backing configuration', () => {
  it('sends the backing filament picked in the settings panel through batch downloads', async () => {
    render(<Converter />);
    await waitFor(() => expect(screen.queryByText('Loading filaments…')).not.toBeInTheDocument());
    const backing = within(screen.getByRole('group', { name: 'Backing filament' }));
    await waitFor(() => expect(backing.getByRole('button', { name: 'White' })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(backing.getByRole('button', { name: 'Key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Batch Processing' }));
    const picker = screen.getByRole('button', { name: /Click to Select Images/ }).parentElement!.querySelector('input')!;
    const file = new File(['image'], 'sample.png', { type: 'image/png' });
    fireEvent.change(picker, { target: { files: [file] } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Download All STLs' })));
    expect(batchDownloadSTL).toHaveBeenLastCalledWith([file], expect.objectContaining({ backingFilament: 'K', whiteBackingLayers: 3 }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Backing filament' })).getByRole('button', { name: 'White' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Download All STLs' })));
    expect(batchDownloadSTL).toHaveBeenLastCalledWith([file], expect.objectContaining({ backingFilament: 'W', whiteBackingLayers: 3 }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('blocks batch STL while a filament TD is invalid, then recovers', async () => {
    render(<Converter />);
    await waitFor(() => expect(screen.queryByText('Loading filaments…')).not.toBeInTheDocument());

    // A freshly added custom color starts with TD=0: the config is invalid.
    fireEvent.click(screen.getByRole('button', { name: 'Add Color' }));

    fireEvent.click(screen.getByRole('button', { name: 'Batch Processing' }));
    const picker = screen.getByRole('button', { name: /Click to Select Images/ }).parentElement!.querySelector('input')!;
    const file = new File(['image'], 'sample.png', { type: 'image/png' });
    fireEvent.change(picker, { target: { files: [file] } });
    const stlButton = screen.getByRole('button', { name: 'Download All STLs' });
    expect(stlButton).toBeDisabled();
    await act(async () => { fireEvent.click(stlButton); });
    expect(batchDownloadSTL).not.toHaveBeenCalled();

    // Fixing the TD re-enables the export.
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Color 6 transmission distance' }), { target: { value: '3' } });
    expect(stlButton).toBeEnabled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download All STLs' })); });
    expect(batchDownloadSTL).toHaveBeenLastCalledWith([file], expect.anything(), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('param-search start is refused while a filament TD is invalid', async () => {
    render(<Converter />);
    await waitFor(() => expect(screen.queryByText('Loading filaments…')).not.toBeInTheDocument());
    await processOneImage();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Compare settings' })); });
    await expect(page_dialog()).toBeVisible();
    expect(screen.getByRole('button', { name: /Generate options/ })).toBeEnabled();

    // Invalidate the configuration behind the open modal, then try to start.
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Color 1 transmission distance' }), { target: { value: '0' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Generate options/ })); });
    expect(startParamSearch).not.toHaveBeenCalled();

    // Repair the TD: the same click now starts the search.
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Color 1 transmission distance' }), { target: { value: '3' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Generate options/ })); });
    expect(startParamSearch).toHaveBeenCalledTimes(1);
  });
});

function page_dialog() {
  return screen.getByRole('dialog', { name: /Compare settings/ });
}
