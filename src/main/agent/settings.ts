/**
 * What the agent link keeps between launches: whether it is on, and its
 * token, encrypted with the system keychain (Electron's safeStorage). When
 * encryption is unavailable the token is never written: it lives until the
 * app quits and the Agent tab says so. A file that cannot be read keeps the
 * link off and is reported, never replaced by a silent default.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const VERSION = 1;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PRIVATE_FILE = 0o600;

/** safeStorage, or a stand-in in tests. */
export interface Encryptor {
  isAvailable(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface SettingsFile {
  /** The content, or undefined when there is no file yet. Throws on any other error. */
  read(): string | undefined;
  write(content: string): void;
}

export interface LoadedSettings {
  enabled: boolean;
  /** Null: no usable token (a new one is made when the link is turned on). */
  token: string | null;
  /** Why the saved settings could not be used. */
  issue?: string;
}

/** 256 random bits, url-safe base64. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

const unusable = (issue: string): LoadedSettings => ({ enabled: false, token: null, issue });

export function loadAgentSettings(file: SettingsFile, encryptor: Encryptor): LoadedSettings {
  let content: string | undefined;
  try {
    content = file.read();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return unusable(`Les réglages du lien agent n'ont pas pu être lus (${typeof code === 'string' ? code : String(error)}) : le lien reste coupé.`);
  }
  if (content === undefined) return { enabled: false, token: null };
  let saved: Record<string, unknown>;
  try {
    saved = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return unusable('Les réglages du lien agent sont illisibles : le lien reste coupé.');
  }
  if (!saved || saved.version !== VERSION || typeof saved.enabled !== 'boolean') {
    return unusable('Les réglages du lien agent sont dans un format inconnu : le lien reste coupé.');
  }
  if (saved.token === undefined) return { enabled: saved.enabled, token: null };
  const token = decryptToken(saved.token, encryptor);
  if (!token) return unusable("Le jeton enregistré n'a pas pu être déchiffré : réactive le lien, un nouveau jeton sera créé.");
  return { enabled: saved.enabled, token };
}

function decryptToken(value: unknown, encryptor: Encryptor): string | undefined {
  if (typeof value !== 'string' || !encryptor.isAvailable()) return undefined;
  try {
    const token = encryptor.decrypt(Buffer.from(value, 'base64'));
    return TOKEN.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

export function saveAgentSettings(file: SettingsFile, encryptor: Encryptor, settings: { enabled: boolean; token: string }): { tokenPersisted: boolean } {
  const tokenPersisted = encryptor.isAvailable();
  const content = {
    version: VERSION,
    enabled: settings.enabled,
    ...(tokenPersisted ? { token: encryptor.encrypt(settings.token).toString('base64') } : {}),
  };
  file.write(JSON.stringify(content));
  return { tokenPersisted };
}

/** The settings file on disk: written to a temporary file, made private, then renamed over. */
export function nodeSettingsFile(path: string): SettingsFile {
  return {
    read: () => {
      try {
        return readFileSync(path, 'utf8');
      } catch (error) {
        if ((error as { code?: unknown }).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    write: (content) => {
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, content, { mode: PRIVATE_FILE });
      chmodSync(temporary, PRIVATE_FILE);
      renameSync(temporary, path);
    },
  };
}
