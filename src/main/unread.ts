/**
 * Unread notifications of the signed-in X account, read from the only place
 * the app can see them: x.com prefixes the page title with the unread count
 * ("(3) Home / X", "(20+) Home / X"). The title is page-controlled, so only a
 * strict `(<1-3 digits>[+]) ` prefix counts, and nothing else of it ever
 * reaches the badge or a notification (their text is fixed by the app).
 *
 * Pure logic: the Dock badge and the native notification are injected sinks,
 * wired in xview.ts.
 */

/** Real counts stop at "20+"; more than 3 digits is not a count. */
const TITLE_PREFIX = /^\((\d{1,3})(\+?)\) /;

export interface Unread {
  count: number;
  /** x.com caps its counter: "(20+)" means at least 20. */
  overflow: boolean;
}

export interface UnreadSink {
  /** The badge text; '' removes it. */
  setBadge(text: string): void;
  notify(unread: Unread): void;
}

const NONE: Unread = { count: 0, overflow: false };

/** The unread count of a page title; 0 (nothing to show) when it has no valid prefix. */
export function parseUnreadTitle(title: string): Unread {
  const match = TITLE_PREFIX.exec(title);
  if (!match) return NONE;
  const count = Number(match[1]);
  return count > 0 ? { count, overflow: match[2] === '+' } : NONE;
}

function badgeText({ count, overflow }: Unread): string {
  return count === 0 ? '' : `${count}${overflow ? '+' : ''}`;
}

/**
 * Tracks the count across title updates. The badge follows every change; a
 * notification fires only when the count exceeds the highest one already
 * notified, and never while the user is looking at X (`isWatching`).
 *
 * x.com's title blinks through count-less values during navigations, so a
 * drop to 0 must not make the same unread notify twice: the ceiling falls
 * back to 0 only once the user has looked at X (they read the notifications),
 * or on reset(). Known limit: unread read elsewhere (phone) does not lower it.
 */
export function createUnreadTracker(sink: UnreadSink, isWatching: () => boolean) {
  let notified = 0;
  let shown: string | undefined;

  const show = (text: string): void => {
    if (text === shown) return;
    shown = text;
    sink.setBadge(text);
  };

  return {
    onTitle(title: string): void {
      const next = parseUnreadTitle(title);
      show(badgeText(next));
      if (isWatching()) {
        notified = next.count;
      } else if (next.count > notified) {
        notified = next.count;
        sink.notify(next);
      }
    },
    /** Sign-out or cleared data: no count of the old account survives. */
    reset(): void {
      notified = 0;
      shown = undefined;
      show('');
    },
  };
}
