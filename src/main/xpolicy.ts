/**
 * URL rules for the embedded x.com view (the "Mon X" tab). Pure functions,
 * no Electron import, so they are unit-tested directly.
 *
 * The view shows the real x.com with the user's own session. It may navigate
 * anywhere on X; sign-in popups (Google, Apple) may open in the app; every
 * other link leaves for the system browser; anything that is not http(s) is
 * refused.
 */

export const X_HOME_URL = 'https://x.com/home';

const X_DOMAINS = ['x.com', 'twitter.com'];
/**
 * Exact hosts of the third-party sign-in offered on X's login page. Not whole
 * domains: sites.google.com or docs.google.com host anyone's content, which
 * could fake a login screen in a popup without an address bar.
 */
const SIGN_IN_HOSTS: ReadonlySet<string> = new Set(['accounts.google.com', 'appleid.apple.com']);

function parse(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function onDomain(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isSignInHost(url: URL): boolean {
  return url.protocol === 'https:' && (SIGN_IN_HOSTS.has(url.hostname) || onDomain(url.hostname, X_DOMAINS));
}

/** An https page of X itself (x.com, twitter.com and their subdomains). */
export function isXUrl(raw: string): boolean {
  const url = parse(raw);
  return url?.protocol === 'https:' && onDomain(url.hostname, X_DOMAINS);
}

export type PopupDecision = 'allow' | 'external' | 'deny';

/**
 * What to do with a window.open / target=_blank from the X view: X pages and
 * sign-in providers open inside the app (same session, so the login sticks),
 * other web links go to the system browser, the rest is refused.
 */
export function popupDecision(raw: string, openerUrl: string): PopupDecision {
  const url = parse(raw);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return 'deny';
  // Only a page of X itself may open an in-app window, never an ad or embed.
  if (isSignInHost(url) && isXUrl(openerUrl)) return 'allow';
  return 'external';
}

/** Where a sign-in popup may navigate: X and the exact sign-in hosts, over https. */
export function isSignInFlowUrl(raw: string): boolean {
  const url = parse(raw);
  return url !== undefined && isSignInHost(url);
}

/** The normalised href of a web link, or undefined: what is checked is what gets opened. */
export function webHref(raw: string): string | undefined {
  const url = parse(raw);
  return url && (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : undefined;
}

/** "https://host" for logs: never the path or query, which may hold tokens. */
export function originForLog(raw: string): string {
  const url = parse(raw);
  return url ? `${url.protocol}//${url.hostname}` : '(invalid url)';
}

/** Allows at most one external open per `intervalMs`: a page cannot flood the system browser. */
export function createOpenLimiter(intervalMs: number, now: () => number = Date.now): () => boolean {
  let last = -Infinity;
  return () => {
    const time = now();
    if (time - last < intervalMs) return false;
    last = time;
    return true;
  };
}

/**
 * The Electron user agent advertises "Electron/x" and the app name, which
 * sign-in providers refuse as an embedded browser. The Chrome part is kept
 * as is (real engine version); only those two tokens are removed.
 */
export function browserUserAgent(electronUserAgent: string): string {
  return electronUserAgent
    .replace(/\s(?:Electron|twitter-desktop|Twitter Desktop|TwitterDesktop)\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounds sent by the renderer: finite, non-negative, rounded. Undefined if malformed. */
export function sanitizeBounds(value: unknown): ViewBounds | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const numbers = ['x', 'y', 'width', 'height'].map((key) => record[key]);
  if (!numbers.every((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 100_000)) {
    return undefined;
  }
  const [x, y, width, height] = numbers.map((n) => Math.round(n as number));
  return { x, y, width, height };
}
