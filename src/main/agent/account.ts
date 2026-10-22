/**
 * Tells when the X account of the "Mon X" tab changes, from its `twid`
 * cookie (the signed-in user id): another account signing in, or a sign-out
 * made inside x.com. The agent link then empties its buffer, so posts of one
 * account are never served as another's. A refresh of the same cookie
 * (removed then set again with the same value) is not a change.
 */
export interface CookieChange {
  value: string;
  removed: boolean;
  /** Electron's cause: 'explicit', 'overwrite', 'expired'... */
  cause: string;
}

export function createAccountWatcher(onChange: () => void) {
  /** undefined: not known yet; null: signed out. */
  let current: string | null | undefined;
  return {
    /** The value at start-up, once read; ignored if a change was already observed. */
    seed(value: string | null): void {
      if (current === undefined) current = value;
    },
    observe(change: CookieChange): void {
      if (change.removed) {
        // An overwrite is followed by the new value: judge that one.
        if (change.cause === 'overwrite') return;
        if (current !== null) onChange();
        current = null;
        return;
      }
      if (current !== undefined && current !== change.value) onChange();
      current = change.value;
    },
  };
}
