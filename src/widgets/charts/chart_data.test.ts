import { describe, expect, it } from 'vitest'
import {
  createChartSeriesDatums,
  decimateBreakAwareDatums,
  type ChartSeriesDatum,
} from './chart_data'
import type { ChartSeries } from './chart_types'

function makeSeries(data: Array<{ x: number; y: number | null }>): ChartSeries {
  return { name: '系列', data }
}

function datumsOf(data: Array<{ x: number; y: number | null }>): ChartSeriesDatum[] {
  return createChartSeriesDatums(makeSeries(data), 0, 'linear')
}

function breakIndexes(datums: readonly { breakBefore: boolean }[]): number[] {
  return datums.flatMap((datum, index) => (datum.breakBefore ? [index] : []))
}

describe('createChartSeriesDatums', () => {
  it('sorts a normal series by x and keeps input order for repeated x values', () => {
    const datums = datumsOf([
      { x: 3, y: 30 },
      { x: 1, y: 10 },
      { x: 2, y: 20 },
      { x: 1, y: 11 },
    ])

    expect(datums.map(datum => datum.xValue)).toEqual([1, 1, 2, 3])
    expect(datums.map(datum => datum.yValue)).toEqual([10, 11, 20, 30])
    expect(datums.map(datum => datum.pointIndex)).toEqual([1, 3, 2, 0])
    expect(datums.map(datum => datum.order)).toEqual([0, 1, 2, 3])
    expect(datums.map(datum => datum.occurrenceIndex)).toEqual([0, 1, 0, 0])
    expect(datums.every(datum => !datum.breakBefore)).toBe(true)
  })

  it('marks a break only on the first valid point after leading nulls', () => {
    const datums = datumsOf([
      { x: 1, y: null },
      { x: 2, y: null },
      { x: 3, y: 3 },
      { x: 4, y: 4 },
    ])

    expect(datums.map(datum => datum.xValue)).toEqual([3, 4])
    expect(datums.map(datum => datum.breakBefore)).toEqual([true, false])
  })

  it('ignores trailing nulls without creating breaks', () => {
    const datums = datumsOf([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: null },
      { x: 4, y: null },
    ])

    expect(datums.map(datum => datum.xValue)).toEqual([1, 2])
    expect(datums.every(datum => !datum.breakBefore)).toBe(true)
  })

  it('collapses consecutive nulls into a single break', () => {
    const datums = datumsOf([
      { x: 1, y: 1 },
      { x: 2, y: null },
      { x: 3, y: null },
      { x: 4, y: null },
      { x: 5, y: 5 },
      { x: 6, y: 6 },
    ])

    expect(datums.map(datum => datum.xValue)).toEqual([1, 5, 6])
    expect(datums.map(datum => datum.breakBefore)).toEqual([false, true, false])
  })

  it('returns no datums when every value is null', () => {
    expect(datumsOf([{ x: 1, y: null }, { x: 2, y: null }])).toEqual([])
  })

  it('keeps a break between repeated x values separated by a null', () => {
    const datums = datumsOf([
      { x: 1, y: 1 },
      { x: 1, y: null },
      { x: 1, y: 2 },
    ])

    expect(datums).toHaveLength(2)
    expect(datums[0]).toMatchObject({ xValue: 1, yValue: 1, occurrenceIndex: 0, breakBefore: false })
    // The null still consumes an occurrence so stacked series stay aligned.
    expect(datums[1]).toMatchObject({ xValue: 1, yValue: 2, occurrenceIndex: 2, breakBefore: true })
  })

  it('keeps input order and the null break when repeated x values arrive unsorted', () => {
    const datums = datumsOf([
      { x: 2, y: 5 },
      { x: 1, y: 1 },
      { x: 1, y: null },
      { x: 1, y: 2 },
    ])

    expect(datums.map(datum => datum.pointIndex)).toEqual([1, 3, 0])
    expect(datums.map(datum => datum.xValue)).toEqual([1, 1, 2])
    expect(datums.map(datum => datum.breakBefore)).toEqual([false, true, false])
  })

  it('positions breaks by sorted x order rather than input order', () => {
    // The null sorts after both valid points, so no break may appear.
    const trailing = datumsOf([
      { x: 3, y: null },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ])
    expect(trailing.map(datum => datum.xValue)).toEqual([1, 2])
    expect(trailing.every(datum => !datum.breakBefore)).toBe(true)

    // The null sorts between the two valid points, so the break lands on x = 3.
    const middle = datumsOf([
      { x: 2, y: null },
      { x: 1, y: 1 },
      { x: 3, y: 3 },
    ])
    expect(middle.map(datum => datum.xValue)).toEqual([1, 3])
    expect(middle.map(datum => datum.breakBefore)).toEqual([false, true])
  })

  it('drops points with non-finite x values without creating breaks', () => {
    const datums = datumsOf([
      { x: 1, y: 1 },
      { x: Number.NaN, y: 5 },
      { x: 2, y: 2 },
    ])

    expect(datums.map(datum => datum.xValue)).toEqual([1, 2])
    expect(datums.every(datum => !datum.breakBefore)).toBe(true)
  })
})

describe('decimateBreakAwareDatums', () => {
  it('keeps every bucket extremum and emits points in original order', () => {
    const data = Array.from({ length: 100 }, (_item, index) => ({
      x: index,
      y: (index * 37) % 10 - 5,
    }))
    data[63]!.y = 999
    data[27]!.y = -999
    const datums = datumsOf(data)

    const result = decimateBreakAwareDatums(datums, { min: 0, max: 99 }, 10)

    // Global spike and dip survive decimation.
    expect(result.some(datum => datum.yValue === 999)).toBe(true)
    expect(result.some(datum => datum.yValue === -999)).toBe(true)
    // Every bucket contributes its own minimum and maximum.
    const bucketOf = (xValue: number): number => Math.max(0, Math.min(9, Math.floor((xValue / 99) * 10)))
    for (let bucket = 0; bucket < 10; bucket += 1) {
      const members = datums.filter(datum => bucketOf(datum.xValue) === bucket)
      const min = Math.min(...members.map(datum => datum.yValue))
      const max = Math.max(...members.map(datum => datum.yValue))
      const xs = members.map(datum => datum.xValue)
      const lo = Math.min(...xs)
      const hi = Math.max(...xs)
      expect(members.length).toBeGreaterThan(0)
      expect(result.some(datum => datum.yValue === min && datum.xValue >= lo && datum.xValue <= hi)).toBe(true)
      expect(result.some(datum => datum.yValue === max && datum.xValue >= lo && datum.xValue <= hi)).toBe(true)
    }
    // Output follows the original order and stays bounded.
    const orders = result.map(datum => datum.order)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
    expect(result.length).toBeLessThanOrEqual(4 * 10 + 2)
    expect(result.every(datum => !datum.breakBefore)).toBe(true)
  })

  it('preserves the break position when decimating across a null', () => {
    const data = Array.from({ length: 101 }, (_item, index) => ({
      x: index,
      y: index === 50 ? null : index % 7,
    }))
    const datums = datumsOf(data)

    const result = decimateBreakAwareDatums(datums, { min: 0, max: 100 }, 10)

    expect(result.some(datum => datum.xValue === 50)).toBe(false)
    const breaks = breakIndexes(result)
    expect(breaks).toHaveLength(1)
    const breakAt = breaks[0]!
    expect(result[breakAt]!.xValue).toBeGreaterThan(50)
    expect(result[breakAt - 1]!.xValue).toBeLessThan(50)
  })

  it('preserves breaks at repeated x values when decimating', () => {
    const datums = datumsOf([
      { x: 1, y: 1 },
      { x: 1, y: null },
      { x: 1, y: 2 },
    ])

    const result = decimateBreakAwareDatums(datums, { min: 0, max: 2 }, 4)

    expect(result.map(datum => datum.yValue)).toEqual([1, 2])
    expect(result.map(datum => datum.breakBefore)).toEqual([false, true])
  })

  it('excludes out-of-viewport points by default and keeps in-viewport extrema', () => {
    const data = Array.from({ length: 100 }, (_item, index) => ({ x: index, y: 1 }))
    data[10]!.y = 900
    data[60]!.y = 500
    data[61]!.y = -500
    const datums = datumsOf(data)

    const result = decimateBreakAwareDatums(datums, { min: 40, max: 69 }, 6)

    expect(result.every(datum => datum.xValue >= 40 && datum.xValue <= 69)).toBe(true)
    expect(result.some(datum => datum.yValue === 900)).toBe(false)
    expect(result.some(datum => datum.yValue === 500)).toBe(true)
    expect(result.some(datum => datum.yValue === -500)).toBe(true)
  })

  it('keeps one edge neighbor on each side without turning them into breaks', () => {
    const data = Array.from({ length: 100 }, (_item, index) => ({ x: index, y: index % 5 }))
    const datums = datumsOf(data)

    const result = decimateBreakAwareDatums(datums, { min: 20, max: 79 }, 10, { includeEdgeNeighbors: true })

    expect(result[0]!.xValue).toBe(19)
    expect(result[result.length - 1]!.xValue).toBe(80)
    expect(result.filter(datum => datum.xValue < 20)).toHaveLength(1)
    expect(result.filter(datum => datum.xValue > 79)).toHaveLength(1)
    // The neighbors join the same run: no break at the viewport edges.
    expect(result.every(datum => !datum.breakBefore)).toBe(true)

    // A viewport spanning the full domain adds no neighbors at all.
    const full = decimateBreakAwareDatums(datums, { min: 0, max: 99 }, 10, { includeEdgeNeighbors: true })
    expect(full.every(datum => datum.xValue >= 0 && datum.xValue <= 99)).toBe(true)
    expect(full.every(datum => !datum.breakBefore)).toBe(true)
  })

  it('does not turn an out-of-viewport null into a break inside the viewport', () => {
    const data = Array.from({ length: 100 }, (_item, index) => ({
      x: index,
      y: index === 10 ? null : index % 5,
    }))
    const datums = datumsOf(data)

    const result = decimateBreakAwareDatums(datums, { min: 20, max: 79 }, 10, { includeEdgeNeighbors: true })

    expect(result[0]!.xValue).toBe(19)
    expect(result.every(datum => !datum.breakBefore)).toBe(true)
  })

  it('keeps real breaks between an edge neighbor and the viewport', () => {
    // Nulls just outside the viewport, between the neighbors and the visible range.
    const data = Array.from({ length: 100 }, (_item, index) => ({
      x: index,
      y: index === 19 || index === 80 ? null : index % 5,
    }))
    const datums = datumsOf(data)

    const result = decimateBreakAwareDatums(datums, { min: 20, max: 79 }, 10, { includeEdgeNeighbors: true })

    expect(result[0]!.xValue).toBe(18)
    expect(result[0]!.breakBefore).toBe(false)
    expect(result[1]!.xValue).toBe(20)
    expect(result[1]!.breakBefore).toBe(true)
    const last = result[result.length - 1]!
    expect(last.xValue).toBe(81)
    expect(last.breakBefore).toBe(true)
    expect(breakIndexes(result)).toHaveLength(2)
  })

  it('keeps the break when the null sits inside the zoomed viewport', () => {
    const data = Array.from({ length: 100 }, (_item, index) => ({
      x: index,
      y: index === 50 ? null : index % 5,
    }))
    const datums = datumsOf(data)

    const result = decimateBreakAwareDatums(datums, { min: 20, max: 79 }, 10, { includeEdgeNeighbors: true })

    const breaks = breakIndexes(result)
    expect(breaks).toHaveLength(1)
    const breakAt = breaks[0]!
    expect(result[breakAt]!.xValue).toBeGreaterThan(50)
    expect(result[breakAt - 1]!.xValue).toBeLessThan(50)
    // Every point before the break belongs to the left run, every point after to the right run.
    expect(result.slice(0, breakAt).every(datum => datum.xValue < 50)).toBe(true)
    expect(result.slice(breakAt).every(datum => datum.xValue > 50)).toBe(true)
  })

  it('preserves extrema at repeated x values when decimating after zoom', () => {
    const data = Array.from({ length: 100 }, (_item, index) => ({ x: index, y: 1 }))
    data.push({ x: 60, y: 60 }, { x: 60, y: -60 })
    const datums = datumsOf(data)

    const result = decimateBreakAwareDatums(datums, { min: 40, max: 79 }, 4, { includeEdgeNeighbors: true })

    const atSixty = result.filter(datum => datum.xValue === 60)
    // The bucket keeps its extrema (60 and -60) in original input order.
    expect(atSixty.map(datum => datum.yValue)).toEqual([60, -60])
    const orders = result.map(datum => datum.order)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
  })

  it('keeps the zoomed shape consistent with a full-range render', () => {
    const data = Array.from({ length: 200 }, (_item, index) => ({
      x: index,
      y: index === 70 || index === 140 ? null : Math.round(Math.sin(index / 5) * 100),
    }))
    data[90]!.y = 500
    const datums = datumsOf(data)
    const viewport = { min: 60, max: 159 }

    const zoomed = decimateBreakAwareDatums(datums, viewport, 25, { includeEdgeNeighbors: true })

    // Both in-viewport nulls produce exactly one break each, at the run boundaries.
    const breaks = breakIndexes(zoomed)
    expect(breaks).toHaveLength(2)
    expect(zoomed[breaks[0]!]!.xValue).toBeGreaterThan(70)
    expect(zoomed[breaks[0]! - 1]!.xValue).toBeLessThan(70)
    expect(zoomed[breaks[1]!]!.xValue).toBeGreaterThan(140)
    expect(zoomed[breaks[1]! - 1]!.xValue).toBeLessThan(140)
    // The spike inside the viewport survives re-decimation after zooming.
    expect(zoomed.some(datum => datum.yValue === 500)).toBe(true)
    // The in-viewport extrema match the full-range extrema inside the viewport.
    const inside = datums.filter(datum => datum.xValue >= viewport.min && datum.xValue <= viewport.max)
    const max = Math.max(...inside.map(datum => datum.yValue))
    const min = Math.min(...inside.map(datum => datum.yValue))
    expect(zoomed.some(datum => datum.yValue === max)).toBe(true)
    expect(zoomed.some(datum => datum.yValue === min)).toBe(true)
    // Output stays in original order and within the neighbor-extended viewport.
    const orders = zoomed.map(datum => datum.order)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
    expect(zoomed.filter(datum => datum.xValue < viewport.min).length).toBeLessThanOrEqual(1)
    expect(zoomed.filter(datum => datum.xValue > viewport.max).length).toBeLessThanOrEqual(1)
  })

  it('returns an empty result for empty input', () => {
    expect(decimateBreakAwareDatums([], { min: 0, max: 1 }, 10)).toEqual([])
  })
})
