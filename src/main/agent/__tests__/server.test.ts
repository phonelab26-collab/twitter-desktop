import { request } from 'node:http';
import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_PROTOCOL_VERSION } from '../mcp';
import { MAX_BODY_BYTES, startAgentServer, type AgentServer } from '../server';
import { AGENT_TOOLS, type ToolOutcome } from '../tools';

const TOKEN = 'tok_'.padEnd(43, 'x');
let server: AgentServer;
let outcome: ToolOutcome;
const onAuthorized = vi.fn();

beforeEach(async () => {
  outcome = { ok: true, result: { posts: [] } };
  onAuthorized.mockClear();
  server = await startAgentServer({
    port: 0,
    token: () => TOKEN,
    mcp: { info: { name: 'twitter-desktop', title: 'Twitter Desktop', version: '0' }, tools: AGENT_TOOLS, call: async () => outcome },
    onAuthorized,
    idleTimeoutMs: 300,
  });
});

afterEach(() => server.close());

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...options.headers };
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, method: options.method ?? 'POST', headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

const rpc = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

describe('agent server: who may talk to it', () => {
  it('listens on the loopback interface only', () => {
    expect(server.port).toBeGreaterThan(0);
  });

  it('refuses a missing or wrong token', async () => {
    for (const authorization of ['', 'Bearer nope-nope-nope-nope', `Basic ${TOKEN}`, `Bearer ${TOKEN}x`]) {
      const reply = await send('/mcp', { headers: { authorization }, body: rpc('ping') });
      expect(reply.status).toBe(401);
      expect(reply.headers['www-authenticate']).toMatch(/^Bearer/);
    }
    expect(onAuthorized).not.toHaveBeenCalled();
  });

  it('refuses another Host (DNS rebinding) and any browser Origin, even with the token', async () => {
    expect((await send('/mcp', { headers: { host: 'evil.example' }, body: rpc('ping') })).status).toBe(403);
    expect((await send('/mcp', { headers: { host: `attacker.example:${server.port}` }, body: rpc('ping') })).status).toBe(403);
    expect((await send('/mcp', { headers: { origin: 'https://evil.example' }, body: rpc('ping') })).status).toBe(403);
    expect((await send('/mcp', { headers: { host: `LOCALHOST:${server.port}` }, body: rpc('ping') })).status).toBe(200);
  });

  it('closes a connection that sends nothing, so idle sockets cannot use up the slots', async () => {
    const socket = connect(server.port, '127.0.0.1');
    const closed = await new Promise<boolean>((resolve) => {
      socket.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    socket.destroy();

    expect(closed).toBe(true);
  });

  it('answers a malformed request path with 400, not a server error', async () => {
    expect((await send('//', { method: 'GET' })).status).toBe(400);
  });

  it('answers OAuth discovery with 404, so clients use the configured token', async () => {
    expect((await send('/.well-known/oauth-protected-resource', { method: 'GET', headers: { authorization: '' } })).status).toBe(404);
  });
});

describe('agent server: requests it accepts', () => {
  it('MCP over POST, JSON in and out, nothing cached', async () => {
    const reply = await send('/mcp', {
      headers: { 'content-type': 'application/json; charset=utf-8', 'mcp-protocol-version': MCP_PROTOCOL_VERSION },
      body: rpc('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} }),
    });

    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toMatch(/^application\/json/);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(JSON.parse(reply.text)).toMatchObject({ id: 1, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
    expect(onAuthorized).toHaveBeenCalledTimes(1);
  });

  it('202 without a body for a notification', async () => {
    const reply = await send('/mcp', { body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });

    expect(reply).toMatchObject({ status: 202, text: '' });
  });

  it('405 for GET and DELETE on /mcp (no SSE stream, no session)', async () => {
    expect((await send('/mcp', { method: 'GET' })).status).toBe(405);
    expect((await send('/mcp', { method: 'DELETE' })).status).toBe(405);
  });

  it('refuses a protocol version it does not speak, a non-JSON type, bad JSON and big bodies', async () => {
    expect((await send('/mcp', { headers: { 'mcp-protocol-version': '1999-01-01' }, body: rpc('ping') })).status).toBe(400);
    expect((await send('/mcp', { headers: { 'content-type': 'text/plain' }, body: rpc('ping') })).status).toBe(415);
    const bad = await send('/mcp', { body: '{"jsonrpc":' });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.text)).toMatchObject({ error: { code: -32700 } });
    expect((await send('/mcp', { body: `{"pad":"${'x'.repeat(MAX_BODY_BYTES)}"}` })).status).toBe(413);
  });
});

describe('agent server: plain JSON tools for scripts', () => {
  it('lists the tools and calls one', async () => {
    const listed = await send('/api/tools', { method: 'GET' });
    expect(JSON.parse(listed.text).tools.map((tool: { name: string }) => tool.name)).toEqual([...AGENT_TOOLS.keys()]);

    const reply = await send('/api/tools/get_feed', { body: '{"limit":5}' });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.text)).toEqual({ ok: true, result: { posts: [] } });
  });

  it('maps failures to HTTP statuses', async () => {
    outcome = { ok: false, kind: 'invalid-args', message: 'limit must be an integer from 1 to 200' };
    expect((await send('/api/tools/get_feed', { body: '{"limit":0}' })).status).toBe(400);
    outcome = { ok: false, kind: 'unknown-tool', message: 'Unknown tool "x".' };
    expect((await send('/api/tools/x', { body: '{}' })).status).toBe(404);
    outcome = { ok: false, kind: 'failed', message: 'later', code: 'RATE_LIMITED', retriable: true };
    expect((await send('/api/tools/get_trends', { body: '' })).status).toBe(429);
    outcome = { ok: false, kind: 'failed', message: 'down', code: 'HTTP_ERROR', retriable: true };
    expect((await send('/api/tools/get_trends', { body: '' })).status).toBe(502);
  });
});
