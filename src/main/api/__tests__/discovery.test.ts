import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crawlOperations, extractAssetRefs, extractOperations, fetchOperationRegistry, findEntryBundleUrl } from '../discovery';

/** Small excerpts of real x-web chunks (the full bundles are X's code and are not redistributed). */
const FIXTURES_DIR = resolve(__dirname, '../__fixtures__');
const readBundle = (name: string): string => readFileSync(resolve(FIXTURES_DIR, name), 'utf8');

describe('extractOperations', () => {
  it('extracts the relay id from a real x-web chunk', () => {
    const { operations: ops, rejected } = extractOperations(readBundle('x-web-generic-timeline.excerpt.js'));

    expect(rejected).toBe(0);
    expect(ops.get('genericTimelineQuery')).toEqual({
      relayId: 'KbQxo6b0b2vQt_SFf37zBA',
      kind: 'query',
    });
  });

  it('never registers response field names as operations', () => {
    // The real URT chunk has `name:`success`` right before the next
    // persisted-query descriptor; a loose regex paired them up.
    const { operations: ops } = extractOperations(readBundle('x-web-urt-chunk.excerpt.js'));

    expect([...ops.keys()].sort()).toEqual([
      'acceptFollowRequestMutation',
      'denyFollowRequestMutation',
      'pinListButtonPinMutation',
      'pinListButtonUnpinMutation',
    ]);
    expect(ops.get('pinListButtonPinMutation')?.kind).toBe('mutation');
  });
});

describe('extractAssetRefs', () => {
  it('lists the chunk references of the real entry bundle', () => {
    const refs = extractAssetRefs(readBundle('x-web-entry-deps.excerpt.js'));

    expect(refs.length).toBeGreaterThan(10);
    expect(refs.every((ref) => /^assets\/[\w.\/-]+\.js$/.test(ref))).toBe(true);
    expect(new Set(refs).size).toBe(refs.length);
  });
});

describe('findEntryBundleUrl', () => {
  it('picks the logged-out entry bundle, not the first x-web script', () => {
    const html =
      '<script src="https://abs.twimg.com/x-web/x-web/assets/vendor-abc.js"></script>' +
      '<script src="https://abs.twimg.com/x-web/x-web/entry-client-logged-out-BSxMcrzD.js"></script>';

    expect(findEntryBundleUrl(html)).toBe(
      'https://abs.twimg.com/x-web/x-web/entry-client-logged-out-BSxMcrzD.js',
    );
  });

  it('throws when the page has no entry bundle', () => {
    expect(() => findEntryBundleUrl('<html></html>')).toThrow(/entry bundle/);
  });
});

describe('crawlOperations', () => {
  const op = (id: string, name: string) =>
    `params:{id:\`${id}\`,metadata:{},name:\`${name}\`,operationKind:\`query\`,text:null}`;

  const site: Record<string, string> = {
    'https://x.com': '<script src="https://abs.twimg.com/x-web/x-web/entry-client-logged-out-E.js">',
    'https://abs.twimg.com/x-web/x-web/entry-client-logged-out-E.js':
      'import("assets/a.js");import("assets/b.js");import("assets/c.js")',
    'https://abs.twimg.com/x-web/x-web/assets/a.js': op('idAxxxxxxxxxxxxxxxxxxx', 'OpA'),
    'https://abs.twimg.com/x-web/x-web/assets/b.js': `${op('idBxxxxxxxxxxxxxxxxxxx', 'OpB')} assets/d.js`,
    'https://abs.twimg.com/x-web/x-web/assets/c.js': op('idCxxxxxxxxxxxxxxxxxxx', 'OpC'),
    'https://abs.twimg.com/x-web/x-web/assets/d.js': op('idDxxxxxxxxxxxxxxxxxxx', 'OpD'),
  };

  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const body = site[url];
    await new Promise((r) => setTimeout(r, 5));
    return body === undefined
      ? new Response('', { status: 404 })
      : new Response(body, { status: 200 });
  }) as typeof fetch;

  it('follows every chunk reference, including ones discovered late', async () => {
    const result = await crawlOperations({ fetch: fakeFetch, concurrency: 4 });

    expect(Object.keys(result.operations).sort()).toEqual(['OpA', 'OpB', 'OpC', 'OpD']);
    expect(result.operations.OpD.relayId).toBe('idDxxxxxxxxxxxxxxxxxxx');
    expect(result.failedBundles).toBe(0);
  });

  it('fails loudly when no operation could be extracted', async () => {
    const empty = (async (input: string | URL | Request) =>
      String(input) === 'https://x.com'
        ? new Response(site['https://x.com'])
        : new Response('', { status: 500 })) as typeof fetch;

    await expect(crawlOperations({ fetch: empty })).rejects.toThrow(/no operation/i);
  });

  it('merges a complete crawl into a registry that a "__proto__" name cannot corrupt', async () => {
    const withProto: Record<string, string> = { ...site, 'https://abs.twimg.com/x-web/x-web/assets/c.js': op('idPxxxxxxxxxxxxxxxxxxx', '__proto__') };
    const protoFetch = (async (input: string | URL | Request) => {
      const body = withProto[String(input)];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body);
    }) as typeof fetch;

    const registry = await fetchOperationRegistry({ fetch: protoFetch });

    expect(registry.OpA.relayId).toBe('idAxxxxxxxxxxxxxxxxxxx');
    expect(Object.getPrototypeOf(registry)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(registry, '__proto__')?.value.relayId).toBe('idPxxxxxxxxxxxxxxxxxxx');
  });

  it('refuses a partial crawl rather than report an operation as absent', async () => {
    const flaky = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/assets/d.js')) return new Response('', { status: 503 });
      const body = site[url];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body);
    }) as typeof fetch;

    await expect(fetchOperationRegistry({ fetch: flaky })).rejects.toThrow(/Partial crawl/);
  });
});

describe('discovery on hostile bundles (synthetic)', () => {
  it('skips and counts a malformed relay id instead of putting it in a URL', () => {
    const good = 'params:{id:`KbQxo6b0b2vQt_SFf37zBA`,metadata:{},name:`Good`,operationKind:`query`';
    const evil = 'params:{id:`../../1.1/x`,metadata:{},name:`Evil`,operationKind:`query`';

    const { operations, rejected } = extractOperations(`${evil} ${good}`);

    expect([...operations.keys()]).toEqual(['Good']);
    expect(rejected).toBe(1);
  });

  it('drops chunk references that climb out of the bundle directory', () => {
    expect(extractAssetRefs('assets/a-1.js assets/../../evil.js')).toEqual(['assets/a-1.js']);
  });

  it('stays linear on a run of "assets/" (no catastrophic backtracking)', () => {
    const hostile = 'assets/'.repeat(200_000);
    const started = performance.now();

    extractAssetRefs(hostile);
    expect(() => findEntryBundleUrl(`https://abs.twimg.com/x-web/x-web/${'a'.repeat(200_000)}`)).toThrow();

    expect(performance.now() - started).toBeLessThan(2000);
  });
});
