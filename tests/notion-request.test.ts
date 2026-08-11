import { describe, expect, it, vi } from 'vitest'
import { getRetryDelay } from '../src/notion-request.js'

describe('getRetryDelay', () => {
  it('uses Retry-After for non-rate-limit errors', () => {
    expect(getRetryDelay(503, 2_000, 0)).toBe(2_000)
  })

  it('falls back to exponential backoff for other errors', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(getRetryDelay(500, null, 0)).toBe(300)
    expect(getRetryDelay(500, null, 1)).toBe(600)
    vi.restoreAllMocks()
  })

  it('waits the rate-limit cooldown when no Retry-After is provided', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(getRetryDelay(429, null, 0)).toBe(67_500)
    vi.restoreAllMocks()
  })

  it('clamps a small Retry-After to the rate-limit cooldown', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(getRetryDelay(429, 0, 0)).toBe(67_500)
    expect(getRetryDelay(429, 30_000, 0)).toBe(67_500)
    vi.restoreAllMocks()
  })

  it('lets a longer Retry-After extend the rate-limit cooldown', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(getRetryDelay(429, 120_000, 0)).toBe(120_000)
    vi.restoreAllMocks()
  })

  it('uses configurable cooldown and jitter values', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(getRetryDelay(429, null, 0, 10_000, 2_000)).toBe(11_000)
    expect(getRetryDelay(429, 5_000, 0, 10_000, 2_000)).toBe(11_000)
    expect(getRetryDelay(429, 15_000, 0, 10_000, 2_000)).toBe(15_000)
    vi.restoreAllMocks()
  })
})
