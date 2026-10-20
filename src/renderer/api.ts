/**
 * Renderer access to the main process: `window.xapi` (preload) and a hook
 * that turns an ApiResult call into loading / data / error states.
 */
import { useCallback, useEffect, useState } from 'react';
import type { XApi } from '@shared/ipc';
import type { ApiError, ApiResult } from '@shared/types';

declare global {
  interface Window {
    xapi: XApi;
  }
}

export const xapi = (): XApi => window.xapi;

export type Remote<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  | { status: 'error'; error: ApiError };

/**
 * Runs `load` whenever `key` changes (null key: nothing to load). A result
 * that arrives after the key changed is dropped, so a slow answer never
 * overwrites a newer one.
 */
export function useRemote<T>(key: string | null, load: () => Promise<ApiResult<T>>): Remote<T> & { reload(): void } {
  const [state, setState] = useState<Remote<T>>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (key === null) {
      setState({ status: 'idle' });
      return;
    }
    let current = true;
    setState({ status: 'loading' });
    load().then(
      (result) => {
        if (current) setState(result.ok ? { status: 'ok', data: result.data } : { status: 'error', error: result.error });
      },
      (error: unknown) => {
        if (current) {
          setState({
            status: 'error',
            error: { message: error instanceof Error ? error.message : String(error), status: 0, retriable: true },
          });
        }
      },
    );
    return () => {
      current = false;
    };
    // `load` is recreated on every render; `key` and `attempt` say when to reload.
  }, [key, attempt]);

  return { ...state, reload };
}

/** Event App listens to: open an x.com page in the "Mon X" tab. */
export const OPEN_X_EVENT = 'xdesktop:open-x';

/** Opens a post or profile on x.com in the "Mon X" tab (the user's own session). */
export function openOnX(url: string): void {
  window.dispatchEvent(new CustomEvent<string>(OPEN_X_EVENT, { detail: url }));
}
