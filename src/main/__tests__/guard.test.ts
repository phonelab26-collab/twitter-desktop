import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;
const appListeners = new Map<string, Listener>();
const electron = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    on: vi.fn(),
    exit: vi.fn(),
  },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('electron', () => electron);

import { failStart, installGlobalGuards, refuseDangerousSwitches } from '../guard';

/** A fake WebContents that records what the guard installs on it. */
function fakeContents() {
  const listeners = new Map<string, Listener>();
  const contents = {
    on: vi.fn((event: string, listener: Listener) => listeners.set(event, listener)),
    setWindowOpenHandler: vi.fn(),
    closeDevTools: vi.fn(),
  };
  return { contents, listeners };
}

beforeEach(() => {
  vi.clearAllMocks();
  appListeners.clear();
  electron.app.isPackaged = true;
  electron.app.on.mockImplementation((event: string, listener: Listener) => appListeners.set(event, listener));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('refuseDangerousSwitches', () => {
  it('exits a packaged app started with a debugging switch, and tells the user', () => {
    const argv = process.argv;
    process.argv = ['/app', '--remote-debugging-port=9222'];
    try {
      refuseDangerousSwitches();
    } finally {
      process.argv = argv;
    }

    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith('Twitter Desktop', expect.stringContaining('--remote-debugging-port'));
    expect(electron.app.exit).toHaveBeenCalledWith(1);
  });

  it('lets development runs through (npm start passes its own switches)', () => {
    electron.app.isPackaged = false;
    const argv = process.argv;
    process.argv = ['/app', '--inspect'];
    try {
      refuseDangerousSwitches();
    } finally {
      process.argv = argv;
    }

    expect(electron.app.exit).not.toHaveBeenCalled();
  });
});

describe('installGlobalGuards', () => {
  it('locks down every new WebContents: no webview, no popup, no DevTools when packaged', () => {
    installGlobalGuards();
    const { contents, listeners } = fakeContents();

    appListeners.get('web-contents-created')?.({}, contents);

    const prevent = vi.fn();
    listeners.get('will-attach-webview')?.({ preventDefault: prevent });
    expect(prevent).toHaveBeenCalled();

    const openHandler = contents.setWindowOpenHandler.mock.calls[0][0] as () => unknown;
    expect(openHandler()).toEqual({ action: 'deny' });

    listeners.get('devtools-opened')?.();
    expect(contents.closeDevTools).toHaveBeenCalled();

    for (const input of [{ key: 'F12' }, { key: 'i', meta: true, alt: true }, { key: 'I', control: true, shift: true }]) {
      const blocked = vi.fn();
      listeners.get('before-input-event')?.({ preventDefault: blocked }, input);
      expect(blocked).toHaveBeenCalled();
    }
    const allowed = vi.fn();
    listeners.get('before-input-event')?.({ preventDefault: allowed }, { key: 'c', meta: true });
    expect(allowed).not.toHaveBeenCalled();
  });

  it('shows a crashed page to the user, but not a clean exit', () => {
    installGlobalGuards();
    const { contents, listeners } = fakeContents();
    appListeners.get('web-contents-created')?.({}, contents);

    listeners.get('render-process-gone')?.({}, { reason: 'clean-exit', exitCode: 0 });
    expect(electron.dialog.showErrorBox).not.toHaveBeenCalled();
    listeners.get('render-process-gone')?.({}, { reason: 'crashed', exitCode: 11 });
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith('Twitter Desktop', expect.stringContaining('crashed'));
  });

  it('never sends a client certificate on its own', () => {
    installGlobalGuards();
    const prevent = vi.fn();
    const callback = vi.fn();

    appListeners.get('select-client-certificate')?.({ preventDefault: prevent }, {}, 'https://x.com', [{}], callback);

    expect(prevent).toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith();
  });
});

describe('failStart', () => {
  it('shows the start-up failure and exits with an error code', () => {
    failStart(new Error('renderer missing'));

    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith('Twitter Desktop', expect.stringContaining('renderer missing'));
    expect(electron.app.exit).toHaveBeenCalledWith(1);
  });
});
