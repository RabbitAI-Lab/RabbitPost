# RabbitPost Mock Server

独立的 Mock Server，用于 RabbitPost 的请求功能验证和交叉测试。

## 功能特性

- ✅ **完整的 HTTP 方法支持**: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS
- ✅ **多种认证方式**: Basic Auth, Bearer Token, API Key, Digest Auth, OAuth2
- ✅ **丰富的请求体类型**: JSON, Form URL Encoded, Multipart, GraphQL, XML, Text, Binary
- ✅ **状态码模拟**: 支持所有常见 HTTP 状态码
- ✅ **高级功能**: 延迟响应、重定向链、Cookie 处理、缓存控制、SSE、流式响应
- ✅ **长连接/多协议**: WebSocket echo、Socket.IO、SSE、MQTT broker、GraphQL（含 WS subscription）、gRPC（含 reflection）、MCP
- ✅ **Postman 兼容**: 可导出 Postman Collection 进行交叉验证

## 快速开始

### 本地开发

```bash
# 安装依赖
npm install

# 开发模式运行（自动检测并清理端口占用）
npm run start:dev

# 生产模式运行
npm run build
npm run start:prod

# 仅检查/清理端口（不启动服务）
npm run start:safe
```

### 端口占用自动处理

MockServer 启动时会自动检测端口 3090 是否被占用：

1. **检测端口**：检查是否有进程在使用端口
2. **优雅终止**：先发送 SIGTERM 信号尝试正常关闭
3. **强制终止**：如果 3 秒后仍占用，发送 SIGKILL 强制终止
4. **启动服务**：端口释放后自动启动服务

```bash
# 手动执行端口清理
npm run start:safe

# 输出示例：
# Checking port 3090...
# Port 3090 is in use. Attempting to free it...
# Found process: node (PID: 12345)
# Sending SIGTERM to PID 12345...
# Port 3090 is now free.
```

### Docker 部署

```bash
# 构建镜像
docker build -t rabbitpost-mock-server .

# 运行容器
docker run -p 3090:3090 rabbitpost-mock-server

# 或使用 docker-compose
docker-compose up -d
```

### 运行测试

```bash
# 运行协议服务单元测试（SSE / GraphQL / WS echo / Socket.IO / MCP）
npm run test

# 运行 e2e 测试
npm run test:e2e

# 导出 Postman Collection
npm run export:postman

# 使用 Newman 运行 Postman 测试
docker-compose --profile test up newman
```

## API 端点

### 基础端点

| 端点 | 方法 | 描述 |
|-----|------|------|
| `/health` | GET | 健康检查 |
| `/echo` | ANY | 回声端点，返回请求详情 |
| `/get` | GET | GET 方法测试 |
| `/post` | POST | POST 方法测试 |
| `/put` | PUT | PUT 方法测试 |
| `/patch` | PATCH | PATCH 方法测试 |
| `/delete` | DELETE | DELETE 方法测试 |
| `/head` | HEAD | HEAD 方法测试 |
| `/options` | OPTIONS | OPTIONS 方法测试 |

### 认证端点

| 端点 | 方法 | 描述 |
|-----|------|------|
| `/auth/basic/:user/:pass` | GET | Basic Auth 验证 |
| `/auth/bearer/:token?` | GET | Bearer Token 验证 |
| `/auth/api-key` | GET | API Key 验证 (query 或 header) |
| `/auth/digest/:user/:pass` | GET | Digest Auth 模拟 |
| `/auth/oauth2/authorize` | GET | OAuth2 授权端点 |
| `/auth/oauth2/token` | POST | OAuth2 令牌端点 |

### 请求体端点

| 端点 | 方法 | 描述 |
|-----|------|------|
| `/body/json` | POST | JSON 体验证 |
| `/body/form` | POST | Form URL Encoded 验证 |
| `/body/multipart` | POST | Multipart Form Data 验证 |
| `/body/graphql` | POST | GraphQL 查询模拟 |
| `/body/xml` | POST | XML 体验证 |
| `/body/text` | POST | 纯文本体验证 |
| `/body/binary` | POST | 二进制体验证 |
| `/body/any` | ANY | 任意类型体验证 |

### 状态码端点

| 端点 | 方法 | 描述 |
|-----|------|------|
| `/status/:code` | ANY | 返回指定状态码 |
| `/status` | GET | 列出所有支持的状态码 |

### 高级端点

| 端点 | 方法 | 描述 |
|-----|------|------|
| `/advanced/delay/:seconds` | GET | 延迟响应 |
| `/advanced/redirect/:count` | GET | 重定向链 |
| `/advanced/cookies` | GET | Cookie 解析 |
| `/advanced/set-cookie` | GET | 设置 Cookie |
| `/advanced/large/:size` | GET | 大响应体 |
| `/advanced/binary` | GET | 二进制响应 (PNG) |
| `/advanced/headers` | GET | 返回所有请求头 |
| `/advanced/response-headers` | ANY | 自定义响应头 |
| `/advanced/cache/:seconds` | GET | 缓存控制 |
| `/advanced/conditional` | GET | 条件请求 (ETag/Last-Modified) |
| `/advanced/stream/:chunks` | GET | 流式响应 |
| `/advanced/sse` | GET | Server-Sent Events |

## 长连接 / 多协议服务

随 `pnpm start:dev` / `pnpm start` 一起启动（MQTT / gRPC 端口被占用时只告警，不影响其他服务）。

### WebSocket echo — `ws://localhost:3090/ws/echo`

- 连接建立后立即收到 greeting 文本帧：`{"type":"welcome","message":"connected to mock ws echo"}`
- 之后发送的文本帧原样 echo 回文本帧；二进制帧原样 echo 回二进制帧

手工验证（Postman）：`New → WebSocket Request`，URL 填 `ws://localhost:3090/ws/echo`，Connect 后应收到 greeting；发送任意文本/二进制消息应原样返回。

### Socket.IO — `ws://localhost:3090/socket.io`（默认路径、默认 namespace，v4）

- 连接建立后立即收到 `welcome` 事件，payload `{ "msg": "hi" }`
- 客户端 emit 任意事件 `X`，服务器回发 `echo:X`，args 原样返回
- 若 emit 时带 ack 回调，ack 收到 `"ack-ok"`

手工验证（Postman）：`New → Socket.IO Request`，URL 填 `http://localhost:3090`。Listen 栏填 `welcome` 与 `echo:ping`，发送事件 `ping`（可带 Ack）观察回包。

### SSE

- `GET /sse/stream`：`text/event-stream`，每 1s 一条，交替默认 message 事件与自定义 `event: tick`，带自增 `id:`（奇数条为 `data: message N`，偶数条为 `event: tick` + `data: tick N`），共 30 条后保持连接不关闭，由客户端自行断开
- `GET /sse/finite`：立即发 3 条（第 2 条为多行 data，第 3 条为自定义 `event: done`）后正常结束响应

手工验证（Postman）：直接新建 GET 请求访问上述 URL，Postman 会以事件流形式展示；或 `curl -N http://localhost:3090/sse/stream`。

### MQTT broker — `tcp://localhost:1883`（aedes，进程内，无认证）

任意 clientId 可连接，支持标准 pub/sub。可用 `MQTT_PORT` 环境变量改端口。

手工验证（Postman）：`New → MQTT Request`，Broker URL 填 `localhost:1883`，Connect 后 Subscribe `test/topic`，再 Publish 同 topic 消息应收到回包。

### GraphQL — `http://localhost:3090/graphql`（graphql-yoga v5）

- `POST /graphql`，introspection 开启；浏览器直接 GET 打开为 GraphiQL
- Query：`hello(name: String): String!`（返回 `Hello, {name}!`，缺省 `world`）、`user(id: ID!): User`（假数据 id=1 Alice / id=2 Bob）
- Mutation：`echo(text: String!): String!`（原样返回）
- Subscription：`tick: Int!` 每 1s 自增，走 `ws://localhost:3090/graphql`（graphql-transport-ws 子协议）

手工验证（Postman）：`New → GraphQL Request`，URL 填 `http://localhost:3090/graphql`，可直接 introspect schema 并执行 query/mutation/subscription。

### gRPC — `localhost:50051`（@grpc/grpc-js，带 v1alpha server reflection）

proto 见 `proto/echo.proto`（与 `apps/runner/proto/echo.proto` 相同），服务 `rabbitpost.test.echo.Echo`：

- `Unary`：返回 `{ text: "echo: " + text, seq: count }`
- `ServerStream`：按 `count`（默认 3）逐条发 `{ text: "echo: " + text + " #i", seq: i }`
- `ClientStream`：收完全部消息后返回 `{ text: "echo: a,b,...", seq: 条数 }`
- `Bidi`：每收到一条即时回显 `{ text: "echo: " + text, seq: 递增 }`

可用 `GRPC_PORT` 环境变量改端口。

手工验证（Postman）：`New → gRPC Request`，URL 填 `localhost:50051`，选择 "Use server reflection" 导入服务定义后即可调用四个方法。

### MCP — `http://localhost:3090/mcp`（@modelcontextprotocol/sdk，stateless Streamable HTTP）

- 仅 `POST`（GET/DELETE 返回 405），每个请求独立无 session
- 工具：`echo { text }` → 返回 `echo: {text}`
- 资源：`memo://notes` 一条静态资源（`mock memo notes`）
- 提示词：`greet { name }` → `hello {name}`

手工验证：用支持 MCP 的客户端以 Streamable HTTP 方式连接 `http://localhost:3090/mcp`；或：

```bash
curl -X POST http://localhost:3090/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

## 交叉验证流程

1. **启动 Mock Server**
   ```bash
   npm run start:dev
   ```

2. **运行 NestJS 测试**
   ```bash
   npm run test:e2e
   ```

3. **导出 Postman Collection**
   ```bash
   npm run export:postman
   ```

4. **导入 Postman 并运行**
   - 打开 Postman
   - 导入 `postman/collection.json`
   - 导入 `postman/environment.json`
   - 运行 Collection

5. **对比结果**
   - 确保 NestJS 测试全部通过
   - 确保 Postman 测试全部通过
   - 对比两边的响应是否一致

## 环境变量

| 变量 | 默认值 | 描述 |
|-----|-------|------|
| `PORT` | `3090` | HTTP / WebSocket / Socket.IO / GraphQL / MCP 端口 |
| `MQTT_PORT` | `1883` | MQTT broker 端口 |
| `GRPC_PORT` | `50051` | gRPC 服务端口 |
| `NODE_ENV` | `development` | 运行环境 |
| `MOCK_SERVER_URL` | `http://localhost:3090` | 用于 Postman 导出的基础 URL |

## 项目结构

```
mock-server/
├── proto/
│   └── echo.proto              # gRPC Echo 服务定义（与 apps/runner 相同）
├── src/
│   ├── main.ts                 # 应用入口（启动与优雅关闭各协议服务）
│   ├── app.module.ts           # 根模块
│   ├── bootstrap.ts            # 共享的 HTTP 中间件配置与各协议服务挂载
│   ├── controllers/
│   │   ├── health.controller.ts    # 健康检查
│   │   ├── echo.controller.ts      # 回声端点
│   │   ├── auth.controller.ts      # 认证端点
│   │   ├── body.controller.ts      # 请求体端点
│   │   ├── status.controller.ts    # 状态码端点
│   │   ├── advanced.controller.ts  # 高级功能端点
│   │   └── sse.controller.ts       # SSE 端点
│   ├── realtime/
│   │   ├── ws-echo.ts              # 原生 WebSocket echo (/ws/echo)
│   │   └── socket-io.gateway.ts    # Socket.IO gateway (/socket.io)
│   ├── graphql/
│   │   └── graphql.setup.ts        # graphql-yoga + graphql-ws subscription
│   ├── grpc/
│   │   └── grpc-server.ts          # gRPC Echo (50051, v1alpha reflection)
│   ├── mqtt/
│   │   └── mqtt-server.ts          # aedes MQTT broker (1883)
│   └── mcp/
│       └── mcp-server.ts           # MCP stateless Streamable HTTP (/mcp)
├── test/
│   ├── app.e2e-spec.ts         # e2e 测试
│   └── protocols.spec.ts       # 协议服务测试（pnpm test）
├── scripts/
│   └── export-postman.ts       # Postman 导出脚本
├── postman/
│   ├── collection.json         # Postman Collection
│   └── environment.json        # Postman Environment
├── Dockerfile                  # Docker 构建文件
├── docker-compose.yml          # Docker Compose 配置
└── package.json
```

## 扩展指南

### 添加新端点

1. 在相应的控制器中添加新方法：

```typescript
@Get('my-endpoint')
myEndpoint(@Req() req: Request, @Res() res: Response) {
  return res.json({ message: 'Hello' });
}
```

2. 在 `test/app.e2e-spec.ts` 中添加测试：

```typescript
it('/my-endpoint (GET)', () => {
  return request(app.getHttpServer())
    .get('/my-endpoint')
    .expect(200)
    .expect((res) => {
      expect(res.body.message).toBe('Hello');
    });
});
```

3. 在 `scripts/export-postman.ts` 中添加 Postman 请求：

```typescript
{
  name: 'My Endpoint',
  request: { method: 'GET', url: '{{baseUrl}}/my-endpoint' },
  event: [
    {
      listen: 'test',
      script: {
        exec: ["pm.test('Status is 200', () => pm.response.to.have.status(200));"],
      },
    },
  ],
}
```

## 许可证

MIT
