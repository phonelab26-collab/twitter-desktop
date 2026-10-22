/**
 * Cashtags ($TSLA) as X itself links them. X computes them with its
 * twitter-text library (Apache-2.0), whose rule is reproduced here: a `$`
 * (or fullwidth `＄`) at the start or after a space, 1 to 6 letters, an
 * optional `.` or `_` class suffix of 1-2 letters, then the end, a space or
 * ASCII punctuation. "$146.03" or "($NVDA)" are not cashtags on X either.
 *
 * The posts' own `cashtag_attachments` field is not a list of symbols: it is
 * empty on real posts whose text has one (fixture with "$SPCX").
 */
const SYMBOL = '[a-z]{1,6}(?:[._][a-z]{1,2})?';
const CASHTAG_IN_TEXT = new RegExp(`(?:^|\\s)[$＄](${SYMBOL})(?=$|\\s|[!-/:-@[-\`{-~])`, 'giu');
const CASHTAG_ALONE = new RegExp(`^[$＄]?(${SYMBOL})$`, 'iu');

/** The distinct cashtags of a text, upper-cased with their `$`, in order of appearance. */
export function extractCashtags(text: string | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const match of text.matchAll(CASHTAG_IN_TEXT)) found.add(`$${match[1].toUpperCase()}`);
  return [...found];
}

/** "$tsla", "TSLA" → "$TSLA"; undefined for anything X would not link as a cashtag. */
export function normaliseCashtag(input: string): string | undefined {
  const match = CASHTAG_ALONE.exec(input.trim());
  return match ? `$${match[1].toUpperCase()}` : undefined;
}
