import { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export const MCP_PATH = '/mcp';

/**
 * 参照 apps/runner/tests/fixtures/mcp-server.mjs 的 stateless 写法：
 * 每个请求新建 server + transport，不带 session。
 */
function createMcpServer() {
  const server = new McpServer({ name: 'rabbitpost-mock-mcp', version: '1.0.0' });

  server.registerTool(
    'echo',
    { description: 'echo back the input text', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
  );

  server.registerResource(
    'notes',
    'memo://notes',
    { description: 'static memo notes' },
    async (uri) => ({
      contents: [{ uri: uri.href, text: 'mock memo notes' }],
    }),
  );

  server.registerPrompt(
    'greet',
    { description: 'greeting prompt', argsSchema: { name: z.string() } },
    async ({ name }) => ({
      messages: [
        { role: 'user', content: { type: 'text', text: `hello ${name}` } },
      ],
    }),
  );

  return server;
}

/**
 * POST /mcp —— stateless Streamable HTTP transport。
 * 需要在 express.json() 之后注册，直接使用已解析的 req.body。
 */
export async function mcpHandler(req: Request, res: Response): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: stateless server, POST only' },
      id: null,
    });
    return;
  }

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: `Internal error: ${(err as Error).message}` },
        id: null,
      });
    }
  }
}
