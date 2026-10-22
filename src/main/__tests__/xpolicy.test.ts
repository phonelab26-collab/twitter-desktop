import { describe, expect, it } from 'vitest';
import { isPermissionAllowed, browserUserAgent, createOpenLimiter, isSignInFlowUrl, isXUrl, popupDecision, boundsFromInsets, sanitizeInsets, webHref } from '../xpolicy';

describe('isXUrl', () => {
  it('accepts https pages of x.com and twitter.com', () => {
    for (const url of ['https://x.com/home', 'https://twitter.com/jack', 'https://help.x.com/', 'https://mobile.twitter.com/']) {
      expect(isXUrl(url)).toBe(true);
    }
  });

  it('rejects look-alikes, http and other schemes', () => {
    for (const url of ['https://x.com.evil.io/', 'https://evilx.com/', 'http://x.com/', 'javascript:alert(1)', 'not a url']) {
      expect(isXUrl(url)).toBe(false);
    }
  });
});

describe('popupDecision', () => {
  const fromX = 'https://x.com/i/flow/login';

  it('keeps X and the exact sign-in hosts inside the app when X opens them', () => {
    expect(popupDecision('https://x.com/i/flow/login', fromX)).toBe('allow');
    expect(popupDecision('https://accounts.google.com/o/oauth2/auth?x=1', fromX)).toBe('allow');
    expect(popupDecision('https://appleid.apple.com/auth/authorize', fromX)).toBe('allow');
  });

  it('sends sites that host anyone\'s content to the system browser, not an in-app popup', () => {
    for (const url of ['https://sites.google.com/view/fake-login', 'https://docs.google.com/forms/x', 'https://www.apple.com/']) {
      expect(popupDecision(url, fromX)).toBe('external');
    }
  });

  it('never opens an in-app popup for a page that is not X', () => {
    expect(popupDecision('https://accounts.google.com/', 'https://ads.example/')).toBe('external');
  });

  it('sends other web links (t.co targets, articles) to the system browser', () => {
    expect(popupDecision('https://t.co/abc', fromX)).toBe('external');
    expect(popupDecision('http://accounts.google.com/', fromX)).toBe('external');
  });

  it('refuses non-web schemes', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'x-apple.systempreferences:']) {
      expect(popupDecision(url, fromX)).toBe('deny');
    }
  });
});

describe('isSignInFlowUrl', () => {
  it('allows X and the exact sign-in hosts only, over https', () => {
    expect(isSignInFlowUrl('https://accounts.google.com/signin')).toBe(true);
    expect(isSignInFlowUrl('https://x.com/i/sso/callback')).toBe(true);
    expect(isSignInFlowUrl('https://sites.google.com/')).toBe(false);
    expect(isSignInFlowUrl('https://phishing.example/')).toBe(false);
    expect(isSignInFlowUrl('http://accounts.google.com/')).toBe(false);
  });
});

describe('webHref and createOpenLimiter', () => {
  it('returns the parsed href of web links only', () => {
    expect(webHref('https://example.com/a b')).toBe('https://example.com/a%20b');
    expect(webHref('file:///etc/passwd')).toBeUndefined();
  });

  it('lets one external open through per interval', () => {
    let now = 0;
    const allow = createOpenLimiter(1000, () => now);

    expect(allow()).toBe(true);
    expect(allow()).toBe(false);
    now = 1000;
    expect(allow()).toBe(true);
  });
});

describe('browserUserAgent', () => {
  it('removes the Electron and app tokens, keeps the real Chrome version', () => {
    const electron =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) twitter-desktop/1.0.0 Chrome/146.0.7680.65 Electron/44.9.0 Safari/537.36';

    expect(browserUserAgent(electron)).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.65 Safari/537.36',
    );
  });
});

describe('sanitizeInsets', () => {
  it('rounds valid insets', () => {
    expect(sanitizeInsets({ left: 220.4, top: 48.6, right: 0, bottom: 0.2 })).toEqual({ left: 220, top: 49, right: 0, bottom: 0 });
  });

  it('rounds a sub-pixel negative inset (fractional zoom) to 0 instead of refusing it', () => {
    expect(sanitizeInsets({ left: 220.4, top: 45, right: -0.3, bottom: -0.5 })).toEqual({ left: 220, top: 45, right: 0, bottom: 0 });
  });

  it('rejects malformed insets', () => {
    const bad = [null, 'x', { left: 1, top: 2, right: 3 }, { left: -1, top: 0, right: 0, bottom: 0 }, { left: NaN, top: 0, right: 0, bottom: 0 }];
    for (const value of bad) expect(sanitizeInsets(value)).toBeUndefined();
  });
});

describe('boundsFromInsets', () => {
  it('fills the window content area minus the insets', () => {
    expect(boundsFromInsets(1280, 860, { left: 221, top: 45, right: 0, bottom: 0 })).toEqual({ x: 221, y: 45, width: 1059, height: 815 });
  });

  it('follows a new window size with the same insets', () => {
    expect(boundsFromInsets(1100, 700, { left: 221, top: 45, right: 10, bottom: 5 })).toEqual({ x: 221, y: 45, width: 869, height: 650 });
  });

  it('converts the insets from CSS pixels when the app UI is zoomed', () => {
    expect(boundsFromInsets(1280, 860, { left: 220, top: 40, right: 0, bottom: 0 }, 1.25)).toEqual({ x: 275, y: 50, width: 1005, height: 810 });
  });

  it('never returns a negative size when the insets exceed the window', () => {
    expect(boundsFromInsets(200, 30, { left: 221, top: 45, right: 0, bottom: 0 })).toEqual({ x: 221, y: 45, width: 0, height: 0 });
  });
});

describe('isPermissionAllowed', () => {
  const x = 'https://x.com/home';

  it('allows the basics x.com needs, only to X pages', () => {
    expect(isPermissionAllowed('notifications', x)).toBe(true);
    expect(isPermissionAllowed('notifications', 'https://evil.example/')).toBe(false);
  });

  it('allows the microphone for Spaces, to X pages only', () => {
    expect(isPermissionAllowed('media', x, ['audio'])).toBe(true);
    expect(isPermissionAllowed('media', x, ['unknown'])).toBe(false);
    expect(isPermissionAllowed('media', 'https://evil.example/', ['audio'])).toBe(false);
  });

  it('refuses the camera, even together with the microphone', () => {
    expect(isPermissionAllowed('media', x, ['video'])).toBe(false);
    expect(isPermissionAllowed('media', x, ['audio', 'video'])).toBe(false);
    expect(isPermissionAllowed('media', x)).toBe(false);
  });

  it('refuses everything else', () => {
    expect(isPermissionAllowed('geolocation', x)).toBe(false);
  });
});
