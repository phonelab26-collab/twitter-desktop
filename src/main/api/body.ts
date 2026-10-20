/**
 * Bounded reads of untrusted HTTP responses, shared by every client.
 *
 * fetch decodes gzip/br transparently, so Content-Length says nothing about
 * the decoded size: a 200 KB gzip can expand to 200 MB in one text() call.
 * readTextCapped counts decoded bytes while streaming and cancels the body as
 * soon as the limit is passed. Limits sit far above the real captures
 * (largest JSON 67 KB, profile page 175 KB, bundle 280 KB).
 */

export const MAX_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_PAGE_BYTES = 4 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
export const MAX_ERROR_BYTES = 64 * 1024;
export const MAX_ACTIVATE_BYTES = 4 * 1024;

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Response body exceeds ${limit} bytes.`);
    this.name = 'BodyTooLargeError';
  }
}

export async function readTextCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError(maxBytes);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new BodyTooLargeError(maxBytes);
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    // Cancelling only releases the socket; the original error is what the caller gets.
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

export class BlockedRedirectError extends Error {
  constructor(from: string, to: string | null) {
    super(`Redirect from ${hostOf(from)} to ${to ? hostOf(to) : '(no location)'} was refused.`);
    this.name = 'BlockedRedirectError';
  }
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return '(invalid url)';
  }
}

const MAX_REDIRECTS = 3;

/**
 * GET that follows redirects only to https URLs on `allowedHosts` (at most
 * three hops): a redirect can never carry the request off X.
 */
export async function fetchPinned(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  allowedHosts: ReadonlySet<string>,
): Promise<Response> {
  let target = url;
  for (let hop = 0; ; hop++) {
    const response = await fetchImpl(target, { ...init, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get('location');
    let next: URL | null = null;
    try {
      next = location ? new URL(location, target) : null;
    } catch {
      next = null;
    }
    if (!next || next.protocol !== 'https:' || !allowedHosts.has(next.hostname) || hop >= MAX_REDIRECTS) {
      throw new BlockedRedirectError(target, next?.href ?? location);
    }
    target = next.href;
  }
}
