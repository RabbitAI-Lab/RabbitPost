// cargo test 用的最小 MCP 测试服务器（stateless Streamable HTTP）。
// 依赖 apps/runner/tests/node/node_modules 里的 @modelcontextprotocol/sdk；
// ESM 解析按脚本路径而非 cwd 查找 node_modules，故用 NODE_FIXTURES_DIR 显式定位。
// 就绪后向 stdout 打印一行 "PORT <n>"。
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(`${process.env.NODE_FIXTURES_DIR}/package.json`);
const { McpServer } = await import(require.resolve("@modelcontextprotocol/sdk/server/mcp.js"));
const { StreamableHTTPServerTransport } = await import(
  require.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js")
);
const { z } = await import(require.resolve("zod"));

function createMcpServer() {
  const server = new McpServer({ name: "test-mcp", version: "1.0.0" });
  server.registerTool(
    "echo",
    { description: "echo back", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );
  server.registerResource("memo", "memo://hello", { description: "static text" }, async (uri) => ({
    contents: [{ uri: uri.href, text: "memo content" }],
  }));
  server.registerPrompt("greet", { description: "greeting", argsSchema: { name: z.string() } },
    async ({ name }) => ({
      messages: [{ role: "user", content: { type: "text", text: `hello ${name}` } }],
    }),
  );
  return server;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString());
}

const httpServer = createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
    res.writeHead(404).end();
    return;
  }
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, await readBody(req));
});

httpServer.listen(0, "127.0.0.1", () => {
  console.log(`PORT ${httpServer.address().port}`);
});
