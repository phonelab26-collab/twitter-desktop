/**
 * Reads the GraphQL results that x.com server-renders into its logged-out
 * pages (docs/HANDOFF.md §5.3).
 *
 * Some operations the public API refuses to guests (UserOriginalsTimeline is
 * a 404 on api.x.com) are run by x.com itself while rendering the page. Their
 * results are streamed into inline scripts, serialised by seroval as:
 *
 *   {kind:"GraphQLRequestStream.Completed",requestId:1,
 *    key:"<relayId><variables JSON>",
 *    result:$R[n]={kind:"Result.Ok",value:"<response JSON>"}}
 *
 * Both `key` and `value` are double-quoted JS string literals. Their escapes
 * are JSON's, except that seroval writes `<` as `\x3C` (so a page cannot close
 * its own <script>): `\xHH` is rewritten to `\u00HH`, then JSON.parse decodes
 * the literal. Anything that still does not decode is BAD_RESPONSE, never skipped.
 */
import { ApiError, ERROR_CODES, type GraphQLResponse } from './client';

const COMPLETED_MARKER = 'kind:"GraphQLRequestStream.Completed"';
const KEY_PREFIX = 'key:';
const OK_PREFIX = 'kind:"Result.Ok",value:';
/** Relay ids are 22 url-safe base64 characters. */
const RELAY_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const RELAY_ID_LENGTH = 22;

export interface SsrResult {
  relayId: string;
  variables: Record<string, unknown>;
  /** The response exactly as the server rendered it (`data` and/or `errors`). */
  response: GraphQLResponse<unknown>;
}

function malformed(detail: string): ApiError {
  return new ApiError(200, `x.com page data could not be read: ${detail}.`, ERROR_CODES.BAD_RESPONSE, {
    retriable: false,
  });
}

/** Decodes the double-quoted string literal that starts at `quoteIndex`. */
function readStringLiteral(source: string, quoteIndex: number): string {
  if (source[quoteIndex] !== '"') throw malformed(`expected a string at offset ${quoteIndex}`);
  let end = quoteIndex + 1;
  while (end < source.length && source[end] !== '"') end += source[end] === '\\' ? 2 : 1;
  if (end >= source.length) throw malformed('unterminated string');
  // Escape pairs are consumed left to right, so "\\x3C" (an escaped backslash) is left alone.
  const literal = source
    .slice(quoteIndex, end + 1)
    .replace(/\\(?:x([0-9A-Fa-f]{2})|[\s\S])/g, (pair: string, hex?: string) => (hex ? `\\u00${hex}` : pair));
  try {
    return JSON.parse(literal) as string;
  } catch {
    throw malformed(`string at offset ${quoteIndex} is not JSON-compatible`);
  }
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw malformed(`${what} is not JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw malformed(`${what} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Splits `<relayId><variables JSON>`. */
function parseKey(key: string): Pick<SsrResult, 'relayId' | 'variables'> {
  const relayId = key.slice(0, RELAY_ID_LENGTH);
  if (!RELAY_ID_PATTERN.test(relayId)) throw malformed(`unexpected request key "${key.slice(0, 40)}"`);
  return { relayId, variables: parseJsonObject(key.slice(RELAY_ID_LENGTH), 'request variables') };
}

/**
 * The text of every inline <script> of a page. Only scripts are searched:
 * page text (a bio, a post) can never pass for server data. A linear scan,
 * no regex over the whole page.
 */
function scriptBodies(html: string): string[] {
  const bodies: string[] = [];
  let at = html.indexOf('<script');
  while (at >= 0) {
    const open = html.indexOf('>', at);
    if (open < 0) break;
    const close = html.indexOf('</script>', open);
    if (close < 0) throw malformed('a <script> is not closed (page cut off?)');
    bodies.push(html.slice(open + 1, close));
    at = html.indexOf('<script', close);
  }
  return bodies;
}

/** The completed results of one script body. */
function resultsIn(source: string): SsrResult[] {
  const results: SsrResult[] = [];
  let at = source.indexOf(COMPLETED_MARKER);
  while (at >= 0) {
    const next = source.indexOf(COMPLETED_MARKER, at + COMPLETED_MARKER.length);
    const segmentEnd = next >= 0 ? next : source.length;

    const keyAt = source.indexOf(KEY_PREFIX, at);
    if (keyAt < 0 || keyAt > segmentEnd) throw malformed('a completed request has no key');
    const { relayId, variables } = parseKey(readStringLiteral(source, keyAt + KEY_PREFIX.length));

    const okAt = source.indexOf(OK_PREFIX, at);
    if (okAt < 0 || okAt > segmentEnd) throw malformed(`request ${relayId} did not complete with Result.Ok`);
    const body = readStringLiteral(source, okAt + OK_PREFIX.length);

    results.push({ relayId, variables, response: parseJsonObject(body, `response of ${relayId}`) });
    at = next;
  }
  return results;
}

/**
 * Every completed GraphQL result of a page, in page order. A page without any
 * yields [] (the caller decides what that means). A completed request whose
 * result is not `Result.Ok` is a server-side failure and throws.
 */
export function extractSsrResults(html: string): SsrResult[] {
  return scriptBodies(html).flatMap(resultsIn);
}

/** True when the page carries the stream framework at all (format not changed). */
export function hasSsrStream(html: string): boolean {
  return html.includes('data-tsr-stream-part') || html.includes('$_TSR');
}
