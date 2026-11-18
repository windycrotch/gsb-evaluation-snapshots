import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ColorBlocksList } from './ColorBlocksList';
import type { ColorBlockSummary } from '../api/types';

const sampleBlocks: ColorBlockSummary[] = [
  { r: 255, g: 0, b: 0, count: 100, hex: '#FF0000' },
  { r: 0, g: 255, b: 0, count: 50, hex: '#00FF00' },
  { r: 0, g: 0, b: 255, count: 25, hex: '#0000FF' },
];

describe('ColorBlocksList', () => {
  it('renders all color blocks', () => {
    render(<ColorBlocksList colorBlocks={sampleBlocks} />);
    expect(screen.getByText('RGB(255,0,0)')).toBeInTheDocument();
    expect(screen.getByText('RGB(0,255,0)')).toBeInTheDocument();
    expect(screen.getByText('RGB(0,0,255)')).toBeInTheDocument();
  });

  it('displays pixel count for each block', () => {
    render(<ColorBlocksList colorBlocks={sampleBlocks} />);
    expect(screen.getByText('100 pixels')).toBeInTheDocument();
    expect(screen.getByText('50 pixels')).toBeInTheDocument();
    expect(screen.getByText('25 pixels')).toBeInTheDocument();
  });

  it('renders color swatches with correct background colors', () => {
    const { container } = render(<ColorBlocksList colorBlocks={sampleBlocks} />);
    const swatches = container.querySelectorAll('[style]');
    expect(swatches).toHaveLength(3);
    expect((swatches[0] as HTMLElement).style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect((swatches[1] as HTMLElement).style.backgroundColor).toBe('rgb(0, 255, 0)');
    expect((swatches[2] as HTMLElement).style.backgroundColor).toBe('rgb(0, 0, 255)');
  });

  it('renders empty list without errors', () => {
    const { container } = render(<ColorBlocksList colorBlocks={[]} />);
    const grid = container.firstChild as HTMLElement;
    expect(grid.children).toHaveLength(0);
  });
});
