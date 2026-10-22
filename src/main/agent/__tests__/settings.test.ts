import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentSettings, newToken, nodeSettingsFile, saveAgentSettings, type Encryptor, type SettingsFile } from '../settings';

/** Reversible stand-in for safeStorage (which needs Electron and the Keychain). */
const encryptor = (available = true): Encryptor => ({
  isAvailable: () => available,
  encrypt: (text) => Buffer.from(`enc:${text}`),
  decrypt: (data) => {
    const text = data.toString();
    if (!text.startsWith('enc:')) throw new Error('bad ciphertext');
    return text.slice(4);
  },
});

function memoryFile(content?: string): SettingsFile & { content?: string } {
  const file: SettingsFile & { content?: string } = {
    content,
    read: () => file.content,
    write: (next) => {
      file.content = next;
    },
  };
  return file;
}

describe('agent settings', () => {
  it('are off with no token when nothing was saved', () => {
    expect(loadAgentSettings(memoryFile(), encryptor())).toEqual({ enabled: false, token: null });
  });

  it('round-trip, with the token encrypted on disk', () => {
    const file = memoryFile();
    const token = newToken();

    expect(saveAgentSettings(file, encryptor(), { enabled: true, token })).toEqual({ tokenPersisted: true });

    expect(file.content).not.toContain(token);
    expect(loadAgentSettings(file, encryptor())).toEqual({ enabled: true, token });
  });

  it('never write the token in clear when encryption is unavailable', () => {
    const file = memoryFile();
    const token = newToken();

    expect(saveAgentSettings(file, encryptor(false), { enabled: true, token })).toEqual({ tokenPersisted: false });

    expect(file.content).not.toContain(token);
    expect(loadAgentSettings(file, encryptor(false))).toEqual({ enabled: true, token: null });
  });

  it('report a corrupt file or an unreadable token, and keep the link off', () => {
    for (const content of ['{not json', '{"version":2,"enabled":true}', JSON.stringify({ version: 1, enabled: true, token: 'garbage' })]) {
      const loaded = loadAgentSettings(memoryFile(content), encryptor());
      expect(loaded).toMatchObject({ enabled: false, token: null });
      expect(loaded.issue).toBeTruthy();
    }
  });

  it('report a file that cannot be read', () => {
    const file: SettingsFile = {
      read: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
      write: () => undefined,
    };

    expect(loadAgentSettings(file, encryptor()).issue).toMatch(/EACCES/);
  });

  it('make 256-bit url-safe tokens', () => {
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(token);
  });
});

describe('nodeSettingsFile', () => {
  it('writes atomically, readable by the user only', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agent-settings-')), 'agent-link.json');
    const file = nodeSettingsFile(path);

    expect(file.read()).toBeUndefined();
    file.write('{"version":1}');

    expect(readFileSync(path, 'utf8')).toBe('{"version":1}');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(file.read()).toBe('{"version":1}');
  });
});
