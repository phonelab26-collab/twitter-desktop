/**
 * End-to-end check of the built app, driven like a user. Run with `npm run e2e`
 * (it builds first). Needs the network: it talks to the real X, as the app does.
 *
 * Every step asserts; the first failure stops the run with exit code 1 and the
 * step name. Screenshots of each step go to $E2E_OUT (default: the OS temp dir).
 */
const { app, clipboard, dialog, Menu, safeStorage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// The agent link asks for confirmation in a native dialog a script cannot click: answer "Activer".
dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
// Never touch the developer's keychain from a test run: the token then lives in memory only.
safeStorage.isEncryptionAvailable = () => false;

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'twitter-desktop-e2e-'));
const STEP_TIMEOUT_MS = 30_000;
const POLL_MS = 250;

const consoleErrors = [];
let window = null;
const results = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const js = (code) => window.webContents.executeJavaScript(code);
const xview = () => window.contentView.children.find((v) => v.webContents && v.webContents !== window.webContents);
const mainText = () => js(`document.querySelector('main')?.innerText ?? ''`);

/** Polls `check` until it returns a truthy value or the step times out. */
async function until(what, check, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for ${what} (last: ${String(last).slice(0, 200)})`);
}

async function shot(name) {
  fs.writeFileSync(path.join(OUT, `${name}-app.png`), (await window.webContents.capturePage()).toPNG());
  const view = xview();
  if (view?.getVisible()) fs.writeFileSync(path.join(OUT, `${name}-x.png`), (await view.webContents.capturePage()).toPNG());
}

const clickButton = (label) =>
  js(`(() => {
    const button = [...document.querySelectorAll('button')].find((b) => b.innerText.trim().includes(${JSON.stringify(label)}));
    if (!button) throw new Error('no button ' + ${JSON.stringify(label)});
    button.click();
  })()`);

/** Types into a React-controlled input (native setter + input event) and submits its form. */
const submitInput = (selector, value) =>
  js(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) throw new Error('no input ' + ${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
  })()`);

/** One MCP call to the agent link, as Claude Code would send it. */
function mcp(url, token, method, params) {
  const { port, pathname } = new URL(url);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function step(name, run) {
  const started = Date.now();
  await run();
  await shot(name);
  results.push(`ok  ${name} (${Date.now() - started} ms)`);
  console.log(`ok  ${name}`);
}

async function scenario() {
  await step('01 opens on Mon X with the real x.com', async () => {
    const view = await until('the X view', () => xview());
    await until('x.com to load', () => view.webContents.getURL().startsWith('https://x.com/'));
    assert.equal(view.getVisible(), true);
    assert.doesNotMatch(view.webContents.getUserAgent(), /Electron/);
  });

  await step('02 x.com has no access to the app', async () => {
    const view = xview();
    assert.equal(await view.webContents.executeJavaScript('typeof window.xapi'), 'undefined');
    assert.equal(await view.webContents.executeJavaScript('typeof require + typeof process'), 'undefinedundefined');
  });

  await step('03 the X view follows the window size', async () => {
    const before = xview().getBounds();
    window.setSize(1100, 760);
    await until('new bounds', () => xview().getBounds().width !== before.width);
    window.setSize(1280, 860);
    await until('bounds restored', () => xview().getBounds().width === before.width);
  });

  await step('04 Tendances hides x.com and lists real trends', async () => {
    await clickButton('Tendances');
    await until('X view hidden', () => !xview().getVisible());
    const count = await until('trend list', () => js(`document.querySelectorAll('.trend').length >= 10 && document.querySelectorAll('.trend').length`));
    assert.ok(count >= 10, `only ${count} trends`);
  });

  await step('05 trends of another country', async () => {
    await until('places list', () => js(`[...document.querySelectorAll('select option')].some((o) => o.text === 'France')`));
    await js(`(() => {
      const select = document.querySelector('select');
      const france = [...select.options].find((o) => o.text === 'France');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, france.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until('France trends', () => js(`document.querySelector('select').selectedOptions[0].text === 'France' && document.querySelectorAll('.trend').length > 0`));
    assert.match(await mainText(), /Mis à jour par X/);
  });

  await step('06 a trend opens as a topic without error', async () => {
    const name = await js(`document.querySelector('.trend .trend-name').innerText`);
    await js(`document.querySelector('.trend').click()`);
    await until('topic view', async () => (await mainText()).includes(`Posts populaires : ${name}`));
    await until('topic loaded', async () => !(await mainText()).includes('Chargement'));
    assert.equal(await js(`document.querySelectorAll('[role=alert]').length`), 0, 'an error box is shown');
  });

  await step('07 popular posts render as cards', async () => {
    await clickButton('Tendances');
    await clickButton('Posts populaires');
    const cards = await until('tweet cards', () => js(`document.querySelectorAll('article.tweet').length`));
    assert.ok(cards >= 1);
  });

  await step('08 "Ouvrir dans Mon X" opens the post in the X tab', async () => {
    await clickButton('Ouvrir dans Mon X');
    await until('X view shown', () => xview().getVisible());
    await until('status page', () => /^https:\/\/x\.com\/[^/]+\/status\/\d+/.test(xview().webContents.getURL()));
  });

  await step('09 a profile and its latest posts', async () => {
    await clickButton('Profil');
    await until('profile form', () => js(`!!document.querySelector('form.search input')`));
    await submitInput('form.search input', '@NASA');
    await until('profile header', async () => (await mainText()).includes('@NASA'));
    const cards = await until('profile posts', () => js(`document.querySelectorAll('article.tweet').length`));
    assert.ok(cards >= 1);
    assert.match(await mainText(), /pas de page suivante/);
  });

  await step('10 an unknown account is reported, not shown empty', async () => {
    await submitInput('form.search input', 'zzqq_nouser_x9');
    await until('not-found notice', async () => (await mainText()).includes("n'existe pas"));
  });

  await step('11 an invalid handle is refused in French, before any request', async () => {
    await submitInput('form.search input', 'not a handle!');
    await until('local input error', async () => (await mainText()).includes('Un nom de compte X fait 1 à 15 caractères'));
  });

  await step('12 menu shortcuts switch tabs, even from x.com', async () => {
    const goTo = (label) => {
      const menu = Menu.getApplicationMenu().items.find((item) => item.label === 'Aller à');
      const item = menu.submenu.items.find((entry) => entry.label === label);
      assert.ok(item, `no menu item ${label}`);
      assert.match(item.accelerator, /^CmdOrCtrl\+[1-5]$/);
      item.click();
    };
    goTo('Mon X');
    await until('X view shown', () => xview().getVisible());
    goTo('Sujet');
    await until('topic view', async () => !xview().getVisible() && (await js(`document.querySelector('h1')?.innerText`)) === 'Sujet');
  });

  await step('13 the Agent tab hides x.com and shows the link state', async () => {
    await clickButton('Agent');
    await until('agent view', async () => !xview().getVisible() && (await js(`document.querySelector('h1')?.innerText`)) === 'Agent');
    const status = await js('window.xapi.agent.status()');
    assert.ok(status.ok);
    if (status.data.enabled) assert.equal((await js('window.xapi.agent.setEnabled(false)')).data.enabled, false);
    await until('toggle', () => js(`[...document.querySelectorAll('button')].some((b) => b.innerText.includes('Activer le lien agent'))`));
  });

  await step('14 an agent reads the posts x.com loaded, with the token only, until the link is cut', async () => {
    const on = await js('window.xapi.agent.setEnabled(true)');
    assert.equal(on.data.enabled, true, on.data.server.message);
    assert.doesNotMatch(JSON.stringify(on.data), /Bearer [A-Za-z0-9_-]{43}/, 'the token reached the UI');
    await js(`window.xapi.agent.copy('token')`);
    const token = await clipboard.readText();
    await clipboard.writeText('');
    xview().webContents.loadURL('https://x.com/NASA');
    const url = on.data.server.url;
    const feed = await until('captured posts', async () => {
      const reply = await mcp(url, token, 'tools/call', { name: 'get_feed', arguments: { limit: 5 } });
      return reply.json.result.structuredContent.posts.length > 0 && reply.json.result.structuredContent;
    });
    assert.ok(feed.posts.every((post) => post.url.startsWith('https://x.com/') && post.sources.includes('profile')));
    assert.equal((await mcp(url, 'x'.repeat(43), 'ping')).status, 401);
    const off = await js('window.xapi.agent.setEnabled(false)');
    assert.equal(off.data.capture.posts, 0);
    await assert.rejects(mcp(url, token, 'ping'), /ECONNREFUSED/);
  });
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (event) => {
    if (event.level === 'error' && contents.getURL().startsWith('file:')) consoleErrors.push(event.message);
  });
});

app.on('browser-window-created', (_event, created) => {
  if (window) return;
  window = created;
  created.webContents.once('did-finish-load', () => {
    scenario()
      .then(() => {
        assert.deepEqual(consoleErrors, [], 'the app UI logged errors');
        console.log(`\n${results.length} steps passed. Screenshots: ${OUT}`);
        app.exit(0);
      })
      .catch(async (error) => {
        await shot('FAILED').catch(() => undefined);
        console.error(`\nFAIL after ${results.length} steps: ${error.message}\nScreenshots: ${OUT}`);
        app.exit(1);
      });
  });
});

require(path.join(ROOT, 'dist', 'main', 'main.js'));
