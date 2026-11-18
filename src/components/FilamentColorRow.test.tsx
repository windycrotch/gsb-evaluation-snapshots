import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FilamentColorRow } from './FilamentColorRow';
import type { FilamentColorConfig } from '../api/types';

const measured: FilamentColorConfig = { name: 'Cyan', hex: '#5489B4', transmission_distance: [1, 4, 10] };

function renderRow(config = measured) {
  const onChange = vi.fn();
  // The real parent applies edits to state; mirror that so validity feedback
  // reacts to what the user typed.
  function StatefulRow() {
    const [value, setValue] = useState(config);
    return (
      <FilamentColorRow
        config={value}
        index={0}
        onChange={(index, updated) => { onChange(index, updated); setValue(updated); }}
        onRemove={vi.fn()}
        canRemove
      />
    );
  }
  render(<StatefulRow />);
  return onChange;
}

describe('material TD editor', () => {
  it('starts with one input and expands measured RGB values without changing data', () => {
    const onChange = renderRow();
    expect(screen.getAllByRole('spinbutton')).toHaveLength(1);
    expect(screen.getByRole('spinbutton')).toHaveValue(5);
    expect(screen.queryByRole('textbox')).toBeNull();
    const button = screen.getByRole('button', { name: 'RGB' });
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('R')).toBeVisible();
    expect(screen.getByRole('spinbutton', { name: 'Color 1 B transmission distance' })).toHaveValue(10);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(4);
    fireEvent.click(button);
    expect(screen.queryByText('R')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(measured.transmission_distance).toEqual([1, 4, 10]);
  });
  it('replaces the measurement only when the single TD is edited', () => {
    const onChange = renderRow();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '6.5' } });
    expect(onChange).toHaveBeenCalledWith(0, { ...measured, transmission_distance: 6.5 });
  });
  it('preserves the measured TD when changing hex', () => {
    const onChange = renderRow();
    fireEvent.change(screen.getByTitle('Pick color'), { target: { value: '#123456' } });
    expect(onChange).toHaveBeenCalledWith(0, { ...measured, hex: '#123456' });
  });
  it('expands a custom scalar without mutation and converts it only on a channel edit', () => {
    const onChange = renderRow({ ...measured, transmission_distance: 5 });
    fireEvent.click(screen.getByRole('button', { name: 'RGB' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('spinbutton', { name: 'Color 1 R transmission distance' })).toHaveValue(5);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Color 1 G transmission distance' }), { target: { value: '7' } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(0, { ...measured, transmission_distance: [5, 7, 5] });
  });
  it('edits a measured channel without overwriting the other channels', () => {
    const onChange = renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'RGB' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Color 1 R transmission distance' }), { target: { value: '2' } });
    expect(onChange).toHaveBeenCalledWith(0, { ...measured, transmission_distance: [2, 4, 10] });
    expect(measured.transmission_distance).toEqual([1, 4, 10]);
  });
  it('permits clearing TD for a new value', () => {
    const onChange = renderRow({ ...measured, transmission_distance: 5 });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(0, { ...measured, transmission_distance: 0 });
  });

  it('keeps zero in state and flags the row invalid with feedback', () => {
    const onChange = renderRow({ ...measured, transmission_distance: 5 });
    const input = screen.getByRole('spinbutton');
    expect(input).toHaveAttribute('aria-invalid', 'false');
    fireEvent.change(input, { target: { value: '0' } });
    expect(onChange).toHaveBeenCalledWith(0, { ...measured, transmission_distance: 0 });
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps a negative scalar in state and flags it until repaired', () => {
    const onChange = renderRow({ ...measured, transmission_distance: 5 });
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '-1' } });
    expect(onChange).toHaveBeenCalledWith(0, { ...measured, transmission_distance: -1 });
    expect(input).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(input, { target: { value: '2.5' } });
    expect(onChange).toHaveBeenCalledWith(0, { ...measured, transmission_distance: 2.5 });
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('treats non-numeric scalar input as an empty field (invalid, flagged)', () => {
    const onChange = renderRow({ ...measured, transmission_distance: 5 });
    // A number input normalizes 'abc' to '' — the same path as clearing.
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: 'abc' } });
    expect(onChange).toHaveBeenCalledWith(0, { ...measured, transmission_distance: 0 });
    expect(screen.getByRole('spinbutton')).toHaveAttribute('aria-invalid', 'true');
  });

  it('flags a negative channel and recovers when repaired', () => {
    renderRow({ ...measured, transmission_distance: [1, 4, 10] });
    fireEvent.click(screen.getByRole('button', { name: 'RGB' }));
    const red = screen.getByRole('spinbutton', { name: 'Color 1 R transmission distance' });
    fireEvent.change(red, { target: { value: '-0.5' } });
    expect(red).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(red, { target: { value: '1.5' } });
    expect(red).toHaveAttribute('aria-invalid', 'false');
  });

  it('flags an over-range channel without marking the other channels invalid', () => {
    renderRow({ ...measured, transmission_distance: [1, 4, 10] });
    fireEvent.click(screen.getByRole('button', { name: 'RGB' }));
    const blue = screen.getByRole('spinbutton', { name: 'Color 1 B transmission distance' });
    fireEvent.change(blue, { target: { value: '2000' } });
    expect(blue).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('spinbutton', { name: 'Color 1 R transmission distance' })).toHaveAttribute('aria-invalid', 'false');
  });
});
