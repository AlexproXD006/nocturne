import { describe, expect, it } from 'vitest'
import { EDIT_MAX_BYTES, checkEditLyrics, detectEditFormat } from '@/pages/admin/lyrics/edit'

describe('admin lyrics edit helpers', () => {
  it('detects LRC by timestamps', () => {
    expect(detectEditFormat('[00:01.00] hi')).toBe('lrc')
    expect(detectEditFormat('[1:02] hi')).toBe('lrc')
    expect(detectEditFormat('just words')).toBe('plain')
  })

  it('validates LRC and builds a preview', () => {
    const c = checkEditLyrics('lrc', '[ti:x]\n[00:01.00] first\n[01:05.50] second')
    expect(c).toMatchObject({ ok: true, lines: 2 })
    expect(c.preview[0]).toBe('0:01  first')
    expect(c.preview[1]).toBe('1:05  second')
  })

  it('rejects LRC without timestamps, empty text and over-size text', () => {
    expect(checkEditLyrics('lrc', 'no stamps').ok).toBe(false)
    expect(checkEditLyrics('plain', '   ').ok).toBe(false)
    const big = checkEditLyrics('plain', 'a'.repeat(EDIT_MAX_BYTES + 1))
    expect(big.ok).toBe(false)
    expect(big.error).toMatch(/200 KB/)
  })

  it('accepts plain text', () => {
    expect(checkEditLyrics('plain', 'one\ntwo\n\nthree')).toMatchObject({ ok: true, lines: 3 })
  })
})
