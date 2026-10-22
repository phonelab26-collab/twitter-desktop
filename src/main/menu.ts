/**
 * Application menu. Edit roles keep copy/paste/undo working in x.com and in
 * the app (on macOS they only work through the menu). The developer tools are
 * offered only in development: in a packaged app they would expose the X
 * session cookie of the "Mon X" tab to anyone at the keyboard.
 */
import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import type { AppView } from '../shared/ipc';

const TABS = [
  ['x', 'Mon X'],
  ['trends', 'Tendances'],
  ['profile', 'Profil'],
  ['topic', 'Sujet'],
  ['agent', 'Agent'],
] as const satisfies ReadonlyArray<readonly [AppView, string]>;
/** Compile-time check that every view has its menu entry (and its ⌘ shortcut). */
const ALL_TABS_LISTED: Exclude<AppView, (typeof TABS)[number][0]> extends never ? true : never = true;

/** `navigate` switches the app tab; the shortcuts work even while x.com has the focus. */
export function installMenu(navigate: (view: AppView) => void): void {
  const isMac = process.platform === 'darwin';
  const view: MenuItemConstructorOptions[] = [
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
  if (!app.isPackaged) view.push({ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' });

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    ...(isMac ? [] : [{ role: 'fileMenu' } as MenuItemConstructorOptions]),
    { role: 'editMenu' },
    { label: 'Affichage', submenu: view },
    {
      label: 'Aller à',
      submenu: (ALL_TABS_LISTED ? TABS : []).map(([name, label], index) => ({
        label,
        accelerator: `CmdOrCtrl+${index + 1}`,
        click: () => navigate(name),
      })),
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
