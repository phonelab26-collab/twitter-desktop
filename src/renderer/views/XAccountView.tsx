import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { XViewInsets, XViewNavigation } from '@shared/ipc';
import type { ApiResult } from '@shared/types';
import { xapi } from '../api';

/** The space around the host element, from each edge of the window (never below 0: a zoomed rect can overhang by a fraction). */
function insetsOf(element: HTMLElement): XViewInsets {
  const rect = element.getBoundingClientRect();
  const inset = (value: number) => Math.max(0, value);
  return { left: inset(rect.left), top: inset(rect.top), right: inset(window.innerWidth - rect.right), bottom: inset(window.innerHeight - rect.bottom) };
}

function sameInsets(a: XViewInsets, b: XViewInsets): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

/**
 * "Mon X": the real x.com with the user's own account. The main process draws
 * it over the placeholder below; this component only reports the space the
 * app UI keeps around it (the main process follows window resizes itself),
 * and hides it again when the tab is left. Signing in happens on X's own page.
 */
export function XAccountView({ url }: { url: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  // A later success clears an earlier error: the banner always reflects the last call.
  const report = (result: ApiResult<unknown>) => setError(result.ok ? null : result.error.message);
  const fail = (cause: unknown) => setError(String(cause));

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const api = xapi().xview;
    let last = insetsOf(element);
    // A zoom of the app UI keeps the CSS insets but changes devicePixelRatio:
    // the main process must hear about it to convert them again.
    let lastRatio = window.devicePixelRatio;
    api.show(last).then(report, fail);

    // A window resize keeps the insets: only a layout change (a banner) or a zoom sends new ones.
    let frame = 0;
    const sync = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = insetsOf(element);
        if (sameInsets(next, last) && window.devicePixelRatio === lastRatio) return;
        last = next;
        lastRatio = window.devicePixelRatio;
        api.setInsets(next).then(report, fail);
      });
    };
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      api.hide().then(report, fail);
    };
  }, []);

  useEffect(() => {
    if (url) xapi().xview.open(url).then(report, fail);
  }, [url]);

  useEffect(() => xapi().xview.onLoadFailed(setError), []);

  const navigate = (action: XViewNavigation) => xapi().xview.navigate(action).then(report, fail);
  // The confirmation dialog is shown by the main process.
  const signOut = () => xapi().xview.signOut().then(report, fail);

  return (
    <section className="xaccount">
      <header className="xaccount-bar">
        <button type="button" className="icon-button" onClick={() => navigate('back')} title="Précédent" aria-label="Précédent">
          ←
        </button>
        <button type="button" className="icon-button" onClick={() => navigate('forward')} title="Suivant" aria-label="Suivant">
          →
        </button>
        <button type="button" className="icon-button" onClick={() => navigate('reload')} title="Recharger" aria-label="Recharger">
          ⟳
        </button>
        <button type="button" className="icon-button" onClick={() => navigate('home')} title="Accueil" aria-label="Accueil">
          ⌂
        </button>
        <button type="button" className="link xaccount-signout" onClick={signOut}>
          Se déconnecter
        </button>
        <span className="muted xaccount-hint">
          Le vrai x.com, avec ton compte. Connecte-toi sur la page de X : l'application ne voit jamais ton mot de passe.
        </span>
      </header>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      <div ref={host} className="xaccount-host" />
    </section>
  );
}
