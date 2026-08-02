# 🥕 RabbitPost

Postman 风格的团队 API 协作平台（Monorepo）。

## 技术栈

| 模块 | 技术 |
| ---- | ---- |
| Monorepo | Nx + pnpm workspaces |
| 前端 `apps/web` | React 19 + Vite + antd 5 + zustand |
| 后端 `apps/api` | Next.js (Route Handlers) + Drizzle ORM |
| CLI `apps/cli` | Rust 单二进制 `rabbitpost`（接口 CRUD / 用例执行 / 报告上传） |
| Runner `apps/runner` | Rust 常驻进程 `rabbitpost-runner`（领取派发任务） |
| 共享库 `crates/rp-core` | Rust 执行引擎 + QuickJS 脚本沙箱（CLI 与 Runner 同源） |
| 数据库 | PostgreSQL（开发环境用 [embedded-postgres](https://www.npmjs.com/package/embedded-postgres)，免安装） |
| 认证 | Casdoor (OIDC，私有化部署) + 个人 API Key（CLI） |

## 目录结构

```
RabbitPost/
├── apps/
│   ├── web/                 # React 前端（Postman 风格 UI）
│   ├── api/                 # Next.js API（团队/Workspace/Collection/Env/History/Runs/请求执行代理）
│   ├── cli/                 # rabbitpost CLI（Rust，本地/CI 用）
│   └── runner/              # rabbitpost-runner（Rust，服务器常驻领取派发任务）
├── crates/
│   └── rp-core/             # CLI 与 Runner 共用的执行引擎 / QuickJS 沙箱 / API 客户端
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
- **Scripts**：Pre-request 与 Tests 脚本（服务端 node:vm、CLI/Runner 内嵌 QuickJS，`rp.*` API + 极简 `rp.expect` 断言，`pm` 为兼容别名）
- **History**：每次请求（含失败）自动落库，可回放为新草稿
- **Runs**：派发任务（Runner 执行）与 CLI 本机执行统一落库，Collection 的 Runs tab 可查看记录与逐请求断言结果
- **RabbitPost CLI**：接口/Collection/文件夹/环境增删改查（JSON 输出，面向 AI），本机执行用例，生成 JSON/HTML/JUnit 报告并上传
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
pnpm runner:build # 构建 Runner（apps/runner/target/release/rabbitpost-runner）
pnpm cli:build    # 构建 CLI（apps/cli/target/release/rabbitpost）
pnpm cli:package  # 交叉编译全平台 CLI 并输出到 apps/api/public/cli（供面板下载）
pnpm runner:test  # Runner + rp-core 测试（单元 + 契约）
pnpm cli:test     # CLI 测试（单元 + assert_cmd/wiremock 功能测试）
```

## 测试与 CI

- `crates/rp-core`：脚本沙箱语义（对齐服务端 pm-sandbox）、{{var}} 替换、执行引擎（变量/Auth/脚本改写/断言翻转/错误透传）、信封与 Runner 契约，均用 wiremock 本地模拟
- `apps/cli`：config/crud/report 单元测试 + `tests/e2e.rs` 功能套件（assert_cmd 跑真实二进制、wiremock 模拟服务端，覆盖 auth/CRUD/run/报告/上传/退出码与用例展开）
- GitHub Actions：`runner-test.yml` / `cli-test.yml` 在相关路径变更时跑 cargo test + clippy（-D warnings）；`runner-release.yml` / `cli-release.yml` 发布预 编译包（`cli-release` 在 main 上 CLI 相关代码变更时自动触发并刷新 cli-latest，PR 只做跨平台构建验证）

## RabbitPost CLI

`rabbitpost` 是本地/CI 用的 Rust 单二进制（与服务端 API Key 认证配合）。
安装方式（三选一）：

- **在「CLI 中心 → RabbitPost CLI」下载预编译包**（推荐）：由 API 的
  `/api/v1/cli/artifacts` 提供，覆盖 macOS（arm64/x64）、Linux（x64/arm64）、Windows（x64）
- **GitHub Releases**：`cli-release` 工作流发布到 `cli-latest`（main 上 `apps/cli` / `crates/rp-core` 变更自动触发，也可 tag `cli-v*` 或手动触发）
- **本地打包**：`pnpm cli:package` 一次构建全部平台（需 zig + cargo-zigbuild + cargo-xwin），
  产物与 manifest 输出到 `apps/api/public/cli/v<version>/` 供本实例直接下载

```bash
# 1. 在 Web「CLI 中心 → RabbitPost CLI」创建 API Key（rpk_...，只展示一次）
# 2. 配置凭证（无需登录，三选一）：
#    a) 命令行参数 --server / --api-key
#    b) 环境变量（CI 推荐）
export RABBITPOST_SERVER=http://localhost:4000
export RABBITPOST_API_KEY=<API_KEY>
#    c) 配置文件（之后所有命令免带参数）
#    echo '{"server":"http://localhost:4000","apiKey":"<API_KEY>"}' > ~/.rabbitpost/config.json

# 3. 增删改查（默认 JSON 输出到 stdout，--table 可切换表格）
rabbitpost team list
rabbitpost request list --collection <COLLECTION_ID>
rabbitpost request create --collection <COLLECTION_ID> --name "获取用户" --method GET --url "{{host}}/users/1"
rabbitpost request update <ITEM_ID> --data @request.json   # @文件 / - stdin / 字面量
rabbitpost env update <ENV_ID> --set host=https://api.example.com

# 4. 本机执行用例（含 rp.* 断言），生成报告并上传（Runs tab 可见）
rabbitpost run --collection <COLLECTION_ID> --env <ENV_ID> \
  --report json,html,junit --report-dir ./reports --upload

# 退出码：0 全部通过 / 1 存在失败用例 / 2 操作错误（CI 可直接作门禁）
```

凭证解析优先级：`--server/--api-key` > `RABBITPOST_SERVER/RABBITPOST_API_KEY` > 配置文件。
Runner（`rabbitpost-runner serve`）使用团队级 Runner Token（`rpr_...`），与 CLI 的个人 API Key 互不通用。

> Windows ARM64 暂缺：rquickjs-sys 未附带 aarch64-pc-windows-msvc 预生成 bindings，
> 需 bindgen 现场生成，后续补齐；ARM 平台已由 macOS arm64 / Linux arm64 覆盖。

## API 一览（均需会话，除 auth 外）

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET | `/api/v1/auth/login` | 获取 Casdoor 授权地址 |
| POST | `/api/v1/auth/callback` | 授权码换会话 |
| GET | `/api/v1/auth/me` | 当前用户（会话或 API Key） |
| GET/POST | `/api/v1/auth/api-keys` | API Key 列表 / 创建（仅会话） |
| DELETE | `/api/v1/auth/api-keys/:id` | 吊销 API Key（仅会话） |
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
| GET | `/api/v1/collections/:id/runs` | 该 Collection 的执行记录（Runs tab） |
| POST | `/api/v1/collections/:id/runs` | CLI 上传执行报告（`rabbitpost.run-report` 格式） |

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
