import { useEffect, useState } from 'react';

const SLOW_AFTER_MS = 10_000;

/**
 * "Chargement…", announced to screen readers; after 10 s it says that X is
 * slow (the app retries for up to about two minutes before giving up).
 */
export function Loading({ label = 'Chargement…' }: { label?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <p className="loading" role="status" aria-live="polite">
      {label}
      {slow && <span className="muted"> X met du temps à répondre, l'application réessaie…</span>}
    </p>
  );
}
