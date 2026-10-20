/**
 * Process-wide protections for an app that holds the user's real X session.
 *
 * - Launch switches that open a debugging port, redirect traffic or weaken
 *   the sandbox are refused in a packaged build (a local process could
 *   otherwise start the signed app with --remote-debugging-port and read the
 *   session cookies, with no Keychain prompt).
 * - Every WebContents, including ones created later or by mistake, gets safe
 *   defaults: no <webview>, no new windows, no DevTools in a packaged build.
 * - No client certificate is ever sent without the user choosing one.
 * - A crashed page or a failed start is shown to the user, not only logged.
 */
import { app, dialog, type WebContents } from 'electron';

const FORBIDDEN_SWITCH =
  /^--(remote-debugging|remote-allow-origins|inspect|auto-open-devtools|js-flags|host-resolver|host-rules|ignore-certificate|ignore-urlfetcher|proxy|load-extension|disable-web-security|disable-site-isolation|no-sandbox|disable-gpu-sandbox|allow-running-insecure|unsafely-treat|renderer-cmd-prefix|gpu-launcher|enable-logging|user-data-dir|dev-server)/i;

/** The first forbidden switch on the command line, if any. */
export function forbiddenSwitch(argv: readonly string[]): string | undefined {
  return argv.slice(1).find((arg) => FORBIDDEN_SWITCH.test(arg));
}

/**
 * Exits a packaged app launched with a debugging or network-override switch.
 * Must run before anything else, ahead of app.whenReady().
 */
export function refuseDangerousSwitches(): void {
  if (!app.isPackaged) return;
  const found = forbiddenSwitch(process.argv);
  if (!found) return;
  dialog.showErrorBox('Twitter Desktop', `Lancement refusé : l'option ${found.split('=')[0]} est interdite dans cette version.`);
  app.exit(1);
}

function blockDevTools(contents: WebContents): void {
  contents.on('devtools-opened', () => contents.closeDevTools());
  contents.on('before-input-event', (event, input) => {
    const key = (input.key ?? '').toLowerCase();
    const letter = key === 'i' || key === 'j' || key === 'c';
    const shortcut =
      key === 'f12' || ((input.control || input.meta) && input.shift && letter) || (input.meta && input.alt && letter);
    if (shortcut) event.preventDefault();
  });
}

/** Shows a crashed page to the user instead of leaving a blank window. */
function reportCrashes(contents: WebContents): void {
  contents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    console.error(`A page process ended (${details.reason}, code ${details.exitCode}).`);
    dialog.showErrorBox(
      'Twitter Desktop',
      `Une page de l'application s'est arrêtée (${details.reason}). Recharge l'onglet ou relance l'application.`,
    );
  });
}

export function installGlobalGuards(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    // Code that needs popups (the X view) replaces this default deny.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    if (app.isPackaged) blockDevTools(contents);
    reportCrashes(contents);
  });

  app.on('select-client-certificate', (event, _contents, _url, _list, callback) => {
    event.preventDefault();
    callback();
  });
}

/** A start-up failure the user can see: a packaged app must never just not appear. */
export function failStart(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Twitter Desktop failed to start:', error);
  dialog.showErrorBox('Twitter Desktop', `Démarrage impossible : ${message}`);
  app.exit(1);
}
