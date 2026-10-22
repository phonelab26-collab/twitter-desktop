/**
 * The local HTTP door of the agent link, on 127.0.0.1 only:
 *   POST /mcp               MCP (Streamable HTTP transport, JSON answers)
 *   GET  /api/tools          the tools, for scripts
 *   POST /api/tools/<name>   one tool call, arguments as a JSON object
 *
 * Every request needs `Authorization: Bearer <token>`. A browser can never
 * use it: any Origin header is refused, the Host must be the loopback address
 * (DNS rebinding), and no CORS header is ever sent. Bodies are capped.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { handleMcpMessage, JSON_RPC, jsonRpcError, MCP_PROTOCOL_VERSION, type McpDeps } from './mcp';

export const MAX_BODY_BYTES = 64 * 1024;
/** A connection that stays silent this long is closed: idle sockets cannot hold all the slots. */
const IDLE_TIMEOUT_MS = 10_000;
const LOOPBACK = '127.0.0.1';
const BEARER = /^Bearer ([A-Za-z0-9_-]{16,256})$/;
const TOOL_PATH = /^\/api\/tools\/([a-z_]{1,40})$/;
const BASE_HEADERS: OutgoingHttpHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export interface AgentServerOptions {
  /** 0 picks a free port (tests). */
  port: number;
  /** Read on every request: a regenerated token applies at once. */
  token(): string;
  mcp: McpDeps;
  /** Called for each request that passed the token check. */
  onAuthorized?(): void;
  /** Tests shorten it. */
  idleTimeoutMs?: number;
}

export interface AgentServer {
  readonly port: number;
  close(): Promise<void>;
}

/** Resolves once listening; rejects with the listen error (EADDRINUSE...). */
export function startAgentServer(options: AgentServerOptions): Promise<AgentServer> {
  return new Promise((resolve, reject) => {
    let port = options.port;
    const server = createServer((req, res) => {
      handle(req, res, port, options).catch((error: unknown) => {
        console.error('[agent] request failed:', error);
        if (!res.headersSent) send(res, 500, { error: 'internal error' });
        else res.destroy();
      });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    // Without a 'timeout' listener, Node destroys a socket idle this long (one that never sends a byte too).
    server.timeout = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    server.maxConnections = 16;
    server.once('error', reject);
    server.listen(options.port, LOOPBACK, () => {
      server.off('error', reject);
      server.on('error', (error) => console.error('[agent] server error:', error));
      const address = server.address();
      port = typeof address === 'object' && address ? address.port : options.port;
      resolve({ port, close: () => closeServer(server) });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse, port: number, options: AgentServerOptions): Promise<void> {
  const host = req.headers.host?.toLowerCase();
  if (host !== `${LOOPBACK}:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'forbidden host' });
  if (req.headers.origin !== undefined) return send(res, 403, { error: 'browser requests are not allowed' });
  const path = pathOf(req.url);
  if (path === undefined) return send(res, 400, { error: 'malformed request path' });
  const tool = TOOL_PATH.exec(path)?.[1];
  if (path !== '/mcp' && path !== '/api/tools' && tool === undefined) return send(res, 404, { error: 'not found' });
  if (!authorized(req.headers.authorization, options.token())) {
    return send(res, 401, { error: 'missing or wrong token' }, { 'WWW-Authenticate': 'Bearer realm="twitter-desktop"' });
  }
  options.onAuthorized?.();
  if (path === '/mcp') return mcpRoute(req, res, options.mcp);
  if (tool === undefined) {
    if (req.method !== 'GET') return send(res, 405, { error: 'use GET' }, { Allow: 'GET' });
    return send(res, 200, { tools: [...options.mcp.tools.values()].map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })) });
  }
  return toolRoute(req, res, tool, options.mcp);
}

/** The path of a request target, or undefined when it does not parse ("//", "//[" ...). */
function pathOf(target: string | undefined): string | undefined {
  try {
    return new URL(target ?? '/', `http://${LOOPBACK}`).pathname;
  } catch {
    return undefined;
  }
}

/** Constant-time comparison of fixed-size digests: the token length does not leak either. */
function authorized(header: string | undefined, expected: string): boolean {
  const match = BEARER.exec(header ?? '');
  if (!match) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(match[1]), digest(expected));
}

async function mcpRoute(req: IncomingMessage, res: ServerResponse, mcp: McpDeps): Promise<void> {
  if (req.method !== 'POST') return send(res, 405, { error: 'use POST (no SSE stream)' }, { Allow: 'POST' });
  const version = req.headers['mcp-protocol-version'];
  if (version !== undefined && version !== MCP_PROTOCOL_VERSION) {
    return send(res, 400, jsonRpcError(null, JSON_RPC.INVALID_REQUEST, `Unsupported MCP-Protocol-Version; this server speaks ${MCP_PROTOCOL_VERSION}.`));
  }
  const body = await readJson(req, res);
  if (!body.ok) return;
  if (body.value === undefined) return send(res, 400, jsonRpcError(null, JSON_RPC.PARSE_ERROR, 'Parse error: empty body.'));
  const answer = await handleMcpMessage(body.value, mcp);
  if (answer === null) {
    res.writeHead(202, BASE_HEADERS);
    res.end();
    return;
  }
  send(res, 200, answer);
}

async function toolRoute(req: IncomingMessage, res: ServerResponse, name: string, mcp: McpDeps): Promise<void> {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'use POST' }, { Allow: 'POST' });
  const body = await readJson(req, res);
  if (!body.ok) return;
  const outcome = await mcp.call(name, body.value);
  if (outcome.ok) return send(res, 200, outcome);
  const status = outcome.kind === 'unknown-tool' ? 404 : outcome.kind === 'invalid-args' ? 400 : outcome.code === 'RATE_LIMITED' ? 429 : 502;
  send(res, status, { ok: false, error: outcome.message, code: outcome.code, retriable: outcome.retriable });
}

/**
 * The JSON body of a POST (undefined when empty). Answers 415, 413 or 400
 * itself and returns ok: false when the body cannot be used.
 */
async function readJson(req: IncomingMessage, res: ServerResponse): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    send(res, 415, { error: 'send application/json' });
    return { ok: false };
  }
  const text = await readCapped(req);
  if (text === undefined) {
    send(res, 413, { error: `body over ${MAX_BODY_BYTES} bytes` }, { Connection: 'close' });
    return { ok: false };
  }
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    const isMcp = req.url?.startsWith('/mcp') === true;
    send(res, 400, isMcp ? jsonRpcError(null, JSON_RPC.PARSE_ERROR, 'Parse error.') : { ok: false, error: 'body is not JSON' });
    return { ok: false };
  }
}

/** The body as text, or undefined past MAX_BODY_BYTES (counted while it streams in). */
function readCapped(req: IncomingMessage): Promise<string | undefined> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.pause();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
