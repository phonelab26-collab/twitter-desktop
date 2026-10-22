import { describe, expect, it } from 'vitest';
import { extractCashtags, normaliseCashtag } from '../cashtags';

describe('extractCashtags', () => {
  // Sentences of real posts (GlobalTrendingSearchTimelineLoggedOut.real.json).
  it('finds the cashtag of real posts', () => {
    expect(extractCashtags('Elon Musk announces he will give 1 of his SpaceX $SPCX shares to "every kid in America"')).toEqual(['$SPCX']);
    expect(extractCashtags('BREAKING: Elon Musk says he will donate one share of SpaceX stock, $SPCX, to every American child')).toEqual(['$SPCX']);
  });

  it('never reads an amount as a cashtag (real posts)', () => {
    expect(extractCashtags('a gift worth about $10.5 BILLION')).toEqual([]);
    expect(extractCashtags("At SpaceX's October 16, 2026 closing price of $146.03, one share per child would represent roughly $10.52")).toEqual([]);
    expect(extractCashtags('with a $1,000 government seed for newborns')).toEqual([]);
  });

  it('follows X\'s own rule: after a space, 1-6 letters, an optional class suffix', () => {
    expect(extractCashtags('$tsla up, $BRK.B flat, ＄eth')).toEqual(['$TSLA', '$BRK.B', '$ETH']);
    expect(extractCashtags('a$TSLA ($NVDA) $TOOLONG')).toEqual([]);
    expect(extractCashtags('$TSLA.')).toEqual(['$TSLA']);
  });

  it('lists each cashtag once, and nothing for a missing text', () => {
    expect(extractCashtags('$TSLA $tsla $TSLA')).toEqual(['$TSLA']);
    expect(extractCashtags(undefined)).toEqual([]);
  });
});

describe('normaliseCashtag', () => {
  it('accepts a symbol with or without $, in any case', () => {
    expect(normaliseCashtag('tsla')).toBe('$TSLA');
    expect(normaliseCashtag(' $brk.b ')).toBe('$BRK.B');
  });

  it('rejects what X would not link as a cashtag', () => {
    for (const bad of ['', '$', '$10', 'TOOLONGX', '$TS LA', 'TSLA;DROP']) expect(normaliseCashtag(bad)).toBeUndefined();
  });
});
