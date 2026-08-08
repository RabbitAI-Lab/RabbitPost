# 多协议 E2E 交叉验证测试方案

目标：以 apps/mock-server 为统一对端，用 **Postman** 与 **RabbitPost** 交叉验证各协议实现行为一致、结果可预期。

## 0. 环境准备

```bash
# 终端 1：mock-server（HTTP :3090、MQTT :1883、gRPC :50051）
cd apps/mock-server && pnpm start:dev

# 终端 2：RabbitPost（web :5173、api :4000，内嵌 Runner 自动拉起）
pnpm dev
```

Postman 侧无需额外准备（Web 版或桌面版均可；桌面版可省代理配置）。

统一地址约定：

| 服务 | 地址 |
| ---- | ---- |
| HTTP / GraphQL / SSE / WS / Socket.IO / MCP | `http://localhost:3090` |
| MQTT broker | `mqtt://localhost:1883` |
| gRPC（带 server reflection） | `localhost:50051` |

## 1. HTTP + GraphQL（Postman Collection 自动比对）

使用 `apps/mock-server/postman/multiprotocol.postman_collection.json`：

1. **Postman**：Import → 选择该文件 → 连同 `multiprotocol.postman_environment.json` 导入并选中环境 → Collection Runner 全量运行 → 全部断言通过。
2. **RabbitPost**：侧边栏 Import 按钮 → 导入同一 collection 文件 → 在环境中配置 `baseUrl=http://localhost:3090`（或导入同名环境变量）→ 逐个请求 Send（或 Runner 跑 Collection）→ 断言结果与 Postman 一致。
3. GraphQL 条目（`GraphQL > hello / user / echo mutation / introspection`）在两侧都应返回相同 JSON。

**验收点**：同一 collection 文件在两个工具中运行结果一致；RabbitPost 导入后 folder 层级、请求名、断言脚本（`pm.*` 兼容别名）完整保留。

## 2. GraphQL

| 步骤 | Postman | RabbitPost | 预期 |
| ---- | ------- | ---------- | ---- |
| Query | New → GraphQL Request，URL `http://localhost:3090/graphql`，查询 `{ hello(name: "Postman") }` | 新建 GraphQL 请求，同样 URL 与查询 | `"Hello, Postman!"` |
| Schema 文档 | Schema 自动加载，可浏览类型 | Schema tab「获取 Schema」→ 文档树展示 Query/Mutation/Subscription/Types | 两侧均看到 schema |
| 补全 | 编辑器输入时有字段补全 | Query 编辑器有 schema 感知补全与 lint | 一致 |
| Mutation | `mutation { echo(text: "hi") }` | 同左 | `"hi"` |
| Subscription（如已实现服务端） | query 切换为 subscription `subscription { tick }` | 点 URL 栏 Subscribe 按钮，切到 Subscription 面板 | 每秒收到自增整数；可 Stop |

## 3. WebSocket

| 步骤 | Postman | RabbitPost | 预期 |
| ---- | ------- | ---------- | ---- |
| 连接 | New → WebSocket Request，`ws://localhost:3090/ws/echo` → Connect | 新建 WebSocket 请求，同 URL → Connect | 收到 welcome greeting JSON |
| 文本 echo | 发送 `hello` | 消息编辑器发 `hello` | 原样收到 `hello`（时间线 in/out 各一条） |
| 二进制 | 消息类型选 Binary 发送 | 编码选 Binary (Base64)，发 `AQID` | 收到相同 base64 负载 |
| 断开 | Disconnect | Disconnect | 状态变为已断开，日志有系统事件 |

## 4. Socket.IO

| 步骤 | Postman | RabbitPost | 预期 |
| ---- | ------- | ---------- | ---- |
| 连接 | New → Socket.IO Request，`http://localhost:3090` → Connect | 新建 Socket.IO 请求（Client v4）→ Connect | 收到 `welcome` 事件 |
| echo | emit 事件 `chat`，参数 `{"text":"hi"}` | 事件名 `chat`、Payload 同左 → Send | 收到 `echo:chat` 携带原参数 + `[ack] chat` 回执 |

注：RabbitPost 当前 Socket.IO 走 Runner（Rust 手写 engine.io），仅 websocket transport、仅 v4；Postman 默认 polling+ws 升级。行为差异属传输层，应用层事件一致。

## 5. MQTT

| 步骤 | Postman | RabbitPost | 预期 |
| ---- | ------- | ---------- | ---- |
| 连接 | New → MQTT Request，`mqtt://localhost:1883` → Connect | 新建 MQTT 请求，同地址 → Connect | 已连接 |
| 订阅 | Subscribe `test/#` | Subscriptions 添加 `test/#` → 订阅 | 列表可见 |
| 发布 | Publish `test/demo` payload `hello` QoS 0 | 发布编辑器同参数 → Publish | 订阅侧收到 `hello`（含 topic） |
| QoS/Retain | Publish retain=true | 勾选 Retain 发布；重新订阅后立即收到保留消息 | 一致 |
| 遗嘱 | 配置 Last Will 后异常断开（直接杀客户端连接）观察另一订阅者 | Settings 配遗嘱，Disconnect 观察另一订阅者 | 订阅者收到遗嘱消息 |

## 6. SSE

| 步骤 | Postman | RabbitPost | 预期 |
| ---- | ------- | ---------- | ---- |
| 持续流 | New → Server-Sent Events Request，`http://localhost:3090/sse/stream` → Connect | 新建 SSE 请求，同 URL → Start | 每秒一条，交替 message / tick 事件 |
| event 过滤 | —（Postman 无过滤 UI） | 过滤框输入 `tick` | 只剩 tick 事件 |
| 有限流 | `http://localhost:3090/sse/finite` | 同左 | 3 条事件后状态自动变为已断开 |

## 7. gRPC

| 步骤 | Postman | RabbitPost | 预期 |
| ---- | ------- | ---------- | ---- |
| 服务发现 | New → gRPC Request，`localhost:50051` → 自动 reflection 出服务列表 | 新建 gRPC 请求，同地址（TLS 关）→ Connect → Services 列表 | 看到 `echo.Echo` 4 个方法及流式标识 |
| Unary | 选 Unary 方法，`{"text":"hi","count":2}` → Invoke | 同左（选方法后自动填充模板） | 返回 `{"text":"echo: hi","count":2}` |
| Server streaming | ServerStream → Invoke | 同左 | 收到 count 条流式消息后 end（code 0） |
| Client streaming | ClientStream → 连续发 3 条 → End stream | Invoke → Push ×3 → Half-close | 返回拼接结果 |
| Bidi | BidiStream → 发一条收一条 | Invoke → Push 即时回显 | 一致 |

## 8. MCP

| 步骤 | Postman | RabbitPost | 预期 |
| ---- | ------- | ---------- | ---- |
| 连接 | New → MCP Request，`http://localhost:3090/mcp`（Streamable HTTP）→ Connect | 新建 MCP 请求（Auto transport）→ Connect | Server 面板显示 test-mcp / 版本 / capabilities |
| tools | tools/list → tools/call `echo` `{text:"hi"}` | 同左 | 返回 `echo: hi` |
| resources / prompts | resources/list、resources/read `memo://notes`、prompts/list、prompts/get `greet` | 同左 | 返回静态资源与提示词 |

## 9. 通过标准

- 全部协议在两个工具中行为一致（允许传输层差异，应用层消息必须一致）
- RabbitPost 侧断言：UI 状态（已连接/已断开）、消息时间线方向与内容、系统事件
- 任何一侧失败：先确认 mock-server 日志收到请求，再定位是客户端（Postman/RabbitPost）还是对端问题
