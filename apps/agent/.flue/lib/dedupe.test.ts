import { describe, expect, it, vi } from 'vitest';
import { TtlLru } from './dedupe.js';

describe('TtlLru', () => {
  it('returns false after the entry expires', () => {
    vi.useFakeTimers();
    try {
      const lru = new TtlLru<string, true>(10, 1_000);
      lru.set('a', true);
      expect(lru.has('a')).toBe(true);
      vi.advanceTimersByTime(1_001);
      expect(lru.has('a')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts the oldest entry when at capacity', () => {
    const lru = new TtlLru<string, true>(2, 60_000);
    lru.set('a', true);
    lru.set('b', true);
    lru.set('c', true);
    expect(lru.has('a')).toBe(false);
    expect(lru.has('b')).toBe(true);
    expect(lru.has('c')).toBe(true);
  });
});
