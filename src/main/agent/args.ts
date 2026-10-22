/**
 * Validation of the arguments an agent sends to a tool: only the declared
 * keys, each of the declared type and range. An agent is a program driven by
 * a model; its arguments are untrusted input like any other.
 */
import { normaliseCashtag } from './cashtags';

export class InvalidArgs extends Error {}

export type Args = Readonly<Record<string, unknown>>;

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** A JSON object with only `allowed` keys and every `required` one; undefined/null is {}. */
export function readArgs(value: unknown, allowed: readonly string[], required: readonly string[] = []): Args {
  if (value === undefined || value === null) {
    if (required.length > 0) throw new InvalidArgs(`missing argument(s): ${required.join(', ')}`);
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new InvalidArgs('arguments must be a JSON object');
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new InvalidArgs(`unknown argument(s): ${unknown.join(', ')}`);
  const missing = required.filter((key) => !keys.includes(key));
  if (missing.length > 0) throw new InvalidArgs(`missing argument(s): ${missing.join(', ')}`);
  return value as Args;
}

export function intArg(args: Args, key: string, min: number, max: number): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InvalidArgs(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/** A non-empty string of at most `maxLength` characters, trimmed. */
export function stringArg(args: Args, key: string, maxLength: number): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new InvalidArgs(`${key} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

export function boolArg(args: Args, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new InvalidArgs(`${key} must be true or false`);
  return value;
}

export function listArg<T extends string>(args: Args, key: string, allowed: readonly T[]): T[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item): item is T => typeof item === 'string' && allowed.includes(item as T))) {
    throw new InvalidArgs(`${key} must be a list of: ${allowed.join(', ')}`);
  }
  return [...value];
}

export function cashtagArg(args: Args, key: string): string | undefined {
  const value = stringArg(args, key, 12);
  if (value === undefined) return undefined;
  const cashtag = normaliseCashtag(value);
  if (!cashtag) throw new InvalidArgs(`${key} must be a cashtag such as $TSLA`);
  return cashtag;
}

/** An X handle, "@" allowed. */
export function handleArg(args: Args, key: string): string | undefined {
  const value = stringArg(args, key, 16)?.replace(/^@/, '');
  if (value === undefined) return undefined;
  if (!HANDLE.test(value)) throw new InvalidArgs(`${key} must be an X handle (1-15 letters, digits or _)`);
  return value;
}
