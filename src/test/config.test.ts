import { describe, expect, it } from 'vitest'

import { DEFAULT_COUNT, MAX_COUNT, parseCount } from '../demo/config'

describe('parseCount：count 参数与非法回退', () => {
    it('缺省时使用默认值且不提示', () => {
        expect(parseCount(null)).toEqual({ count: DEFAULT_COUNT, fallback: false })
        expect(parseCount(undefined)).toEqual({ count: DEFAULT_COUNT, fallback: false })
    })

    it('合法正整数原样采用', () => {
        expect(parseCount('1')).toEqual({ count: 1, fallback: false })
        expect(parseCount('20000')).toEqual({ count: 20000, fallback: false })
        expect(parseCount(String(MAX_COUNT))).toEqual({ count: MAX_COUNT, fallback: false })
    })

    it.each([
        ['空串', ''],
        ['空白', '   '],
        ['0', '0'],
        ['负数', '-5'],
        ['小数', '12.5'],
        ['科学计数', '1e5'],
        ['字母', 'abc'],
        ['混合', '100abc'],
        ['超出上限', String(MAX_COUNT + 1)],
        ['远超上限', '999999999'],
        ['非安全整数', '99999999999999999999']
    ])('%s 回退到默认值并给出提示', (_name, raw) => {
        const result = parseCount(raw)
        expect(result.count).toBe(DEFAULT_COUNT)
        expect(result.fallback).toBe(true)
        expect(result.message).toBeTruthy()
        expect(result.message).toContain(String(DEFAULT_COUNT))
    })

    it('提示文字会带上原始输入，便于用户定位问题', () => {
        expect(parseCount('abc').message).toContain('abc')
        expect(parseCount(String(MAX_COUNT + 1)).message).toContain(String(MAX_COUNT))
    })
})
