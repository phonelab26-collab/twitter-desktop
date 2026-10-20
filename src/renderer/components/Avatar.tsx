import { useState } from 'react';

/**
 * A user's avatar; when X sent none, the handle's first letter instead of a
 * fake picture. `largeUrl` (a bigger variant derived from the sent url) falls
 * back to `url` if it does not load, then to the letter.
 */
export function Avatar({ url, largeUrl, handle, size = 40 }: { url?: string; largeUrl?: string; handle: string; size?: number }) {
  const candidates = [largeUrl, url].filter((value): value is string => Boolean(value));
  const [failed, setFailed] = useState(0);
  const src = candidates[failed];
  if (src) {
    return (
      <img className="avatar" src={src} alt="" width={size} height={size} loading="lazy" onError={() => setFailed((n) => n + 1)} />
    );
  }
  return (
    <span className="avatar avatar-fallback" style={{ width: size, height: size }} aria-hidden="true">
      {handle.charAt(0).toUpperCase()}
    </span>
  );
}
