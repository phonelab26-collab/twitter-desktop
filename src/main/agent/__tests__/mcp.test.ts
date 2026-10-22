import { describe, expect, it, vi } from 'vitest';
import { handleMcpMessage, MCP_PROTOCOL_VERSION, type McpDeps } from '../mcp';
import { AGENT_TOOLS, type ToolOutcome } from '../tools';

function deps(outcome: ToolOutcome = { ok: true, result: { posts: [] } }): McpDeps & { call: ReturnType<typeof vi.fn> } {
  return {
    info: { name: 'twitter-desktop', title: 'Twitter Desktop', version: '1.2.3' },
    tools: AGENT_TOOLS,
    call: vi.fn(async () => outcome),
  };
}

const request = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: '2.0', id, method, params });
/** The `result` of a successful answer (the tests check the shape themselves). */
const resultOf = (response: unknown) => (response as { result: Record<string, any> }).result;

describe('handleMcpMessage', () => {
  it('initialize: agrees on the protocol version and introduces the server', async () => {
    const response = await handleMcpMessage(
      request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } }),
      deps(),
    );

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'twitter-desktop', version: '1.2.3' },
      },
    });
    expect(resultOf(response).instructions).toMatch(/untrusted/i);
  });

  it('initialize: offers its own version when the client asks for another', async () => {
    const response = await handleMcpMessage(request('initialize', { protocolVersion: '2099-01-01', capabilities: {} }), deps());

    expect(response).toMatchObject({ result: { protocolVersion: MCP_PROTOCOL_VERSION } });
  });

  it('answers nothing to notifications and to client responses', async () => {
    expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps())).toBeNull();
    expect(await handleMcpMessage({ jsonrpc: '2.0', id: 7, result: {} }, deps())).toBeNull();
  });

  it('ping and tools/list', async () => {
    expect(await handleMcpMessage(request('ping', undefined, 'p'), deps())).toEqual({ jsonrpc: '2.0', id: 'p', result: {} });

    const listed = resultOf(await handleMcpMessage(request('tools/list'), deps()));
    expect(listed.tools.map((tool: { name: string }) => tool.name)).toEqual([...AGENT_TOOLS.keys()]);
    expect(listed.tools[0]).toMatchObject({ inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } });
  });

  it('tools/call: the result as structured content and as text', async () => {
    const d = deps({ ok: true, result: { posts: [{ id: '1' }] } });

    const response = await handleMcpMessage(request('tools/call', { name: 'get_feed', arguments: { limit: 1 } }), d);

    expect(d.call).toHaveBeenCalledWith('get_feed', { limit: 1 });
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: '{"posts":[{"id":"1"}]}' }], structuredContent: { posts: [{ id: '1' }] }, isError: false },
    });
  });

  it('tools/call: a tool that failed is a result with isError, so the model sees why', async () => {
    const response = await handleMcpMessage(
      request('tools/call', { name: 'get_trends', arguments: {} }),
      deps({ ok: false, kind: 'failed', message: 'later', code: 'RATE_LIMITED', retriable: true }),
    );

    expect(response).toMatchObject({ result: { isError: true } });
    expect(JSON.parse(resultOf(response).content[0].text)).toEqual({
      error: 'later',
      code: 'RATE_LIMITED',
      retriable: true,
    });
  });

  it('tools/call: unknown tool or invalid arguments are invalid params', async () => {
    for (const outcome of [
      { ok: false, kind: 'unknown-tool', message: 'Unknown tool "x".' },
      { ok: false, kind: 'invalid-args', message: 'limit must be an integer from 1 to 200' },
    ] as const) {
      expect(await handleMcpMessage(request('tools/call', { name: 'x', arguments: {} }), deps(outcome))).toMatchObject({
        error: { code: -32602, message: outcome.message },
      });
    }
    expect(await handleMcpMessage(request('tools/call', { arguments: {} }), deps())).toMatchObject({ error: { code: -32602 } });
  });

  it('rejects unknown methods, batches and malformed messages', async () => {
    expect(await handleMcpMessage(request('resources/list'), deps())).toMatchObject({ id: 1, error: { code: -32601 } });
    expect(await handleMcpMessage([request('ping')], deps())).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await handleMcpMessage({ jsonrpc: '1.0', id: 1, method: 'ping' }, deps())).toMatchObject({ error: { code: -32600 } });
    expect(await handleMcpMessage({ jsonrpc: '2.0', id: null, method: 'ping' }, deps())).toMatchObject({ error: { code: -32600 } });
    expect(await handleMcpMessage('ping', deps())).toMatchObject({ id: null, error: { code: -32600 } });
  });
});
