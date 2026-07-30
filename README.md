# 🥕 RabbitPost

Postman 风格的团队 API 协作平台（Monorepo）。

## 技术栈

| 模块 | 技术 |
| ---- | ---- |
| Monorepo | Nx + pnpm workspaces |
| 前端 `apps/web` | React 19 + Vite + antd 5 + zustand |
| 后端 `apps/api` | Next.js (Route Handlers) + Drizzle ORM |
| 数据库 | PostgreSQL（开发环境用 [embedded-postgres](https://www.npmjs.com/package/embedded-postgres)，免安装） |
| 认证 | Casdoor (OIDC，私有化部署) |

## 目录结构

```
RabbitPost/
├── apps/
│   ├── web/                 # React 前端（Postman 风格 UI）
│   └── api/                 # Next.js API（团队/Workspace/Collection/Env/History/请求执行代理）
├── packages/
│   └── shared/              # 前后端共享的领域模型与 API 契约
├── nx.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## 核心功能

- **团队管理**：团队 CRUD、成员邀请（按邮箱）、角色（owner/admin/editor/viewer）
- **Workspace 管理**：团队下多 Workspace，CRUD
- **Collection 管理**：Collection + 自引用树（folder/request 无限层级），拖拽排序字段预留
- **环境变量**：多环境、Key-Value 变量、secret 标记、请求中 `{{var}}` 引用
- **HTTP 请求**：服务端代理执行（规避 CORS），支持 params/headers/body(raw/form-data/urlencoded/binary)/auth(bearer/basic/api-key)
- **Scripts**：Pre-request 与 Tests 脚本（node:vm 沙箱，`pm.*` API + 极简 `pm.expect` 断言）
- **History**：每次请求（含失败）自动落库，可回放为新草稿
- **错误透传**：上游/网络错误原文返回，不做封装改写

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 配置环境变量
cp .env.example .env
#    编辑 .env，填入你的 Casdoor 配置（见下文）

# 3. 启动嵌入式 PostgreSQL（保持前台运行，首次会下载 PG 二进制）
pnpm db:up

# 4. 另开终端，同步数据库表结构
pnpm db:push

# 5. 启动前后端（web: http://localhost:5173, api: http://localhost:4000）
pnpm dev
```

### Casdoor 配置

1. 在你的 Casdoor 实例创建一个 Application，`Redirect URLs` 添加：
   `http://localhost:5173/auth/callback`
2. 将以下信息填入根目录 `.env`：
   - `CASDOOR_ENDPOINT`：Casdoor 服务地址，如 `https://casdoor.example.com`
   - `CASDOOR_CLIENT_ID` / `CASDOOR_CLIENT_SECRET`
   - `CASDOOR_ORGANIZATION` / `CASDOOR_APPLICATION`
   - `CASDOOR_CERT`：Application 关联证书的公钥（用于验签 id_token）
3. `APP_SESSION_SECRET` 改为随机串：`openssl rand -hex 32`

> 未配置 Casdoor 时，登录接口会返回 `503 CASDOOR_NOT_CONFIGURED` 及明确提示。

## 常用命令

```bash
pnpm dev          # 并行启动 web + api（nx run-many）
pnpm dev:web      # 仅前端
pnpm dev:api      # 仅后端
pnpm db:up        # 启动嵌入式 PG（开发）
pnpm db:push      # drizzle-kit 同步 schema 到数据库
pnpm build        # 全部构建
pnpm typecheck    # 全部类型检查
```

## API 一览（均需会话，除 auth 外）

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET | `/api/v1/auth/login` | 获取 Casdoor 授权地址 |
| POST | `/api/v1/auth/callback` | 授权码换会话 |
| GET | `/api/v1/auth/me` | 当前用户 |
| GET/POST | `/api/v1/teams` | 团队列表 / 创建 |
| GET/PATCH/DELETE | `/api/v1/teams/:id` | 团队详情/更新/删除 |
| GET/POST/PATCH/DELETE | `/api/v1/teams/:id/members` | 成员管理 |
| GET/POST | `/api/v1/workspaces` | Workspace 列表(?teamId=) / 创建 |
| GET/POST | `/api/v1/workspaces/:id/collections` | Collection 列表 / 创建 |
| GET | `/api/v1/collections/:id/tree` | Collection 树（folder/request） |
| POST | `/api/v1/collections/:id/items` | 新建条目 |
| GET/PATCH/DELETE | `/api/v1/items/:id` | 条目详情/更新/删除 |
| GET/POST | `/api/v1/workspaces/:id/environments` | 环境列表 / 创建 |
| GET/PATCH/DELETE | `/api/v1/environments/:id` | 环境详情/更新/删除 |
| GET/DELETE | `/api/v1/workspaces/:id/history` | 历史列表 / 清空 |
| POST | `/api/v1/execute` | 服务端代理执行 HTTP 请求 |

## 脚本沙箱（pm API）

```js
// Pre-request：发送前执行
pm.environment.set("ts", Date.now());
pm.variables.set("token", "xxx");
console.log(pm.environment.get("baseUrl"));

// Tests：响应返回后执行
pm.test("status is 200", () => {
  pm.response.to.have.status(200);
});
pm.test("body has id", () => {
  const body = pm.response.json();
  pm.expect(body.id).to.exist();
});
```

## 生产部署要点

- `DATABASE_URL` 指向真实 PostgreSQL，`db:push`（或 `db:generate` 生成迁移）同步表结构
- `WEB_ORIGIN` 改为前端正式域名，并在 Casdoor 添加对应 redirect URL
- `pnpm build` 后，`apps/api` 以 `next start` 运行，`apps/web` 产物为静态文件
