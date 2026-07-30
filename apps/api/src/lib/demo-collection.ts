/**
 * 默认 Demo Collection（Rabbit Post Api Demo）种子数据。
 * 覆盖 RabbitPost 全部 API 端点，按模块分文件夹；URL 统一使用 {{baseUrl}} 变量。
 * 新建 workspace 时自动播种；已有 workspace 可用 scripts/seed-demo-collection.ts 回填。
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  createEmptyRequestConfig,
  type HttpMethod,
  type KeyValueItem,
  type RequestConfig,
} from "@rabbitpost/shared";
import { db } from "../db";
import { collectionItems, collections } from "../db/schema";

export const DEMO_COLLECTION_NAME = "Rabbit Post Api Demo";

const DEMO_COLLECTION_DESCRIPTION = `# Rabbit Post Api Demo

RabbitPost 自身全部 API 的示例 Collection，按模块分文件夹。

## 使用前准备

1. 新建一个 Environment，添加变量 \`baseUrl\`（本地开发填 \`http://localhost:4000\`）；
2. 路径中的 \`{{teamId}}\` / \`{{workspaceId}}\` 等占位变量可在 Environment 中按需补充；
3. 所有 \`/api/v1/*\` 接口都要求已通过 Casdoor 登录（携带会话 Cookie）。

所有响应统一为 \`{ ok: true, data }\` 或 \`{ ok: false, error }\` 信封结构。`;

// ---------------------------------------------------------------------------
// 定义结构
// ---------------------------------------------------------------------------

interface DemoRequestDef {
  name: string;
  method: HttpMethod;
  url: string;
  /** query 参数示例（默认 enabled） */
  params?: Array<{ key: string; value: string; description?: string; enabled?: boolean }>;
  /** raw JSON body 示例 */
  bodyJson?: unknown;
  /** 请求文档（Markdown） */
  docs?: string;
}

interface DemoFolderDef {
  name: string;
  /** 文件夹 Overview 文档（Markdown） */
  description: string;
  requests: DemoRequestDef[];
}

function kv(
  items: Array<{ key: string; value: string; description?: string; enabled?: boolean }>,
): KeyValueItem[] {
  return items.map((it) => ({
    id: randomUUID(),
    key: it.key,
    value: it.value,
    enabled: it.enabled ?? true,
    ...(it.description !== undefined ? { description: it.description } : {}),
  }));
}

function toRequestConfig(def: DemoRequestDef): RequestConfig {
  const config = createEmptyRequestConfig();
  config.method = def.method;
  config.url = def.url;
  if (def.params) config.params = kv(def.params);
  if (def.bodyJson !== undefined) {
    config.body = {
      type: "raw",
      rawLanguage: "json",
      raw: JSON.stringify(def.bodyJson, null, 2),
    };
    config.headers = kv([{ key: "Content-Type", value: "application/json" }]);
  }
  if (def.docs) config.docs = def.docs;
  return config;
}

// ---------------------------------------------------------------------------
// 端点清单（与 apps/api/src/app/api 下路由一一对应）
// ---------------------------------------------------------------------------

const DEMO_FOLDERS: DemoFolderDef[] = [
  {
    name: "Health",
    description: "服务健康检查，无需登录。",
    requests: [
      {
        name: "Health check",
        method: "GET",
        url: "{{baseUrl}}/api/health",
        docs: "返回服务状态与当前时间，可用于探活。",
      },
    ],
  },
  {
    name: "Auth",
    description: "Casdoor OIDC 登录 / 会话相关接口。",
    requests: [
      {
        name: "Get login URL",
        method: "GET",
        url: "{{baseUrl}}/api/v1/auth/login",
        params: [
          {
            key: "redirect_uri",
            value: "{{baseUrl}}/auth/callback",
            description: "授权回跳地址；缺省为 WEB_ORIGIN/auth/callback",
            enabled: false,
          },
        ],
        docs: "返回 Casdoor 授权地址 `authorizeUrl` 与 `state`，前端整页跳转完成登录。",
      },
      {
        name: "Exchange code (callback)",
        method: "POST",
        url: "{{baseUrl}}/api/v1/auth/callback",
        bodyJson: { code: "<authorization-code>", redirectUri: "{{baseUrl}}/auth/callback" },
        docs: "用 Casdoor 授权码换取 token 并写入会话 Cookie；Casdoor 侧错误原文透传。",
      },
      {
        name: "Current user",
        method: "GET",
        url: "{{baseUrl}}/api/v1/auth/me",
        docs: "返回当前会话用户；未登录时 `user` 为 null。",
      },
      {
        name: "Logout",
        method: "POST",
        url: "{{baseUrl}}/api/v1/auth/logout",
        docs: "清除会话 Cookie。",
      },
    ],
  },
  {
    name: "Teams",
    description: "团队的增删改查；角色从低到高：viewer / editor / admin / owner。",
    requests: [
      {
        name: "List my teams",
        method: "GET",
        url: "{{baseUrl}}/api/v1/teams",
        docs: "返回当前用户加入的团队列表（含自己在团队中的角色）。",
      },
      {
        name: "Create team",
        method: "POST",
        url: "{{baseUrl}}/api/v1/teams",
        bodyJson: { name: "My Team", slug: "my-team" },
        docs: "创建团队，创建者自动成为 owner；`slug` 可省略（按名称自动生成）。",
      },
      {
        name: "Get team",
        method: "GET",
        url: "{{baseUrl}}/api/v1/teams/{{teamId}}",
        docs: "团队详情，需为团队成员。",
      },
      {
        name: "Update team",
        method: "PATCH",
        url: "{{baseUrl}}/api/v1/teams/{{teamId}}",
        bodyJson: { name: "Renamed Team" },
        docs: "更新团队名称 / 头像，需 admin+。",
      },
      {
        name: "Delete team",
        method: "DELETE",
        url: "{{baseUrl}}/api/v1/teams/{{teamId}}",
        docs: "删除团队（级联删除 workspace 等数据），仅 owner。",
      },
    ],
  },
  {
    name: "Team Members",
    description: "团队成员管理，需 admin+；owner 不可被修改或移除。",
    requests: [
      {
        name: "List members",
        method: "GET",
        url: "{{baseUrl}}/api/v1/teams/{{teamId}}/members",
        docs: "返回团队成员列表（含用户信息与角色）。",
      },
      {
        name: "Add member",
        method: "POST",
        url: "{{baseUrl}}/api/v1/teams/{{teamId}}/members",
        bodyJson: { email: "user@example.com", role: "editor" },
        docs: "按邮箱邀请成员（对方需至少通过 Casdoor 登录过一次）；`role` 可选 viewer / editor / admin。",
      },
      {
        name: "Update member role",
        method: "PATCH",
        url: "{{baseUrl}}/api/v1/teams/{{teamId}}/members",
        bodyJson: { userId: "{{memberUserId}}", role: "admin" },
        docs: "调整成员角色，不能修改 owner。",
      },
      {
        name: "Remove member",
        method: "DELETE",
        url: "{{baseUrl}}/api/v1/teams/{{teamId}}/members",
        bodyJson: { userId: "{{memberUserId}}" },
        docs: "移除成员，不能移除 owner。",
      },
    ],
  },
  {
    name: "Workspaces",
    description: "工作空间的增删改查；workspace 隶属于团队。",
    requests: [
      {
        name: "List workspaces",
        method: "GET",
        url: "{{baseUrl}}/api/v1/workspaces",
        params: [{ key: "teamId", value: "{{teamId}}", description: "团队 ID，必填" }],
        docs: "返回指定团队下的 workspace 列表；未传 teamId 时返回空数组。",
      },
      {
        name: "Create workspace",
        method: "POST",
        url: "{{baseUrl}}/api/v1/workspaces",
        bodyJson: { teamId: "{{teamId}}", name: "My Workspace", description: "Demo workspace" },
        docs: "创建 workspace（editor+）；会自动附带本 Demo Collection。",
      },
      {
        name: "Get workspace",
        method: "GET",
        url: "{{baseUrl}}/api/v1/workspaces/{{workspaceId}}",
        docs: "workspace 详情。",
      },
      {
        name: "Update workspace",
        method: "PATCH",
        url: "{{baseUrl}}/api/v1/workspaces/{{workspaceId}}",
        bodyJson: { name: "Renamed Workspace", description: null },
        docs: "更新名称 / 描述，editor+。",
      },
      {
        name: "Delete workspace",
        method: "DELETE",
        url: "{{baseUrl}}/api/v1/workspaces/{{workspaceId}}",
        docs: "删除 workspace（级联删除其下数据），admin+。",
      },
    ],
  },
  {
    name: "Collections",
    description: "Collection 的增删改查与侧边栏拖拽排序。",
    requests: [
      {
        name: "List collections",
        method: "GET",
        url: "{{baseUrl}}/api/v1/workspaces/{{workspaceId}}/collections",
        docs: "返回 workspace 下的 Collection 列表（按 sortOrder 排序）。",
      },
      {
        name: "Create collection",
        method: "POST",
        url: "{{baseUrl}}/api/v1/workspaces/{{workspaceId}}/collections",
        bodyJson: { name: "New Collection", description: "Created from demo" },
        docs: "新建 Collection（editor+），排在列表末尾。",
      },
      {
        name: "Reorder collections",
        method: "PATCH",
        url: "{{baseUrl}}/api/v1/workspaces/{{workspaceId}}/collections",
        bodyJson: { orderedIds: ["{{collectionId}}"] },
        docs: "按数组顺序重排 sortOrder（editor+）；需传入该 workspace 全部 Collection id。",
      },
      {
        name: "Get collection",
        method: "GET",
        url: "{{baseUrl}}/api/v1/collections/{{collectionId}}",
        docs: "Collection 详情。",
      },
      {
        name: "Update collection",
        method: "PATCH",
        url: "{{baseUrl}}/api/v1/collections/{{collectionId}}",
        bodyJson: { name: "Renamed Collection", description: "Updated overview" },
        docs: "更新名称 / Overview 描述，editor+。",
      },
      {
        name: "Delete collection",
        method: "DELETE",
        url: "{{baseUrl}}/api/v1/collections/{{collectionId}}",
        docs: "删除 Collection（级联删除全部条目），editor+。",
      },
      {
        name: "Get collection tree",
        method: "GET",
        url: "{{baseUrl}}/api/v1/collections/{{collectionId}}/tree",
        docs: "返回嵌套树（folder / request），侧边栏展示用。",
      },
      {
        name: "Create item (folder / request)",
        method: "POST",
        url: "{{baseUrl}}/api/v1/collections/{{collectionId}}/items",
        bodyJson: {
          parentId: null,
          type: "request",
          name: "New Request",
          request: { method: "GET", url: "https://httpbin.org/get" },
        },
        docs: "在 Collection 中新建文件夹或请求（editor+）；`type` 为 folder 时不传 `request`。",
      },
    ],
  },
  {
    name: "Collection Items",
    description: "Collection 内条目（folder / request）的读取、更新与删除。",
    requests: [
      {
        name: "Get item",
        method: "GET",
        url: "{{baseUrl}}/api/v1/items/{{itemId}}",
        docs: "单个条目详情（request 类型含完整请求配置）。",
      },
      {
        name: "Update item",
        method: "PATCH",
        url: "{{baseUrl}}/api/v1/items/{{itemId}}",
        bodyJson: { name: "Renamed Item", parentId: null, sortOrder: 0 },
        docs: "重命名 / 移动 / 排序 / 保存请求配置（`request` 字段整体替换），editor+。",
      },
      {
        name: "Delete item",
        method: "DELETE",
        url: "{{baseUrl}}/api/v1/items/{{itemId}}",
        docs: "删除条目（folder 连同子级一并删除），editor+。",
      },
    ],
  },
  {
    name: "Documents",
    description: "workspace 级文档树（folder / document，Markdown 正文）。",
    requests: [
      {
        name: "Get document tree",
        method: "GET",
        url: "{{baseUrl}}/api/v1/workspaces/{{workspaceId}}/documents",
        docs: "返回 workspace 的文档嵌套树。",
      },
      {
        name: "Create document / folder",
        method: "POST",
        url: "{{baseUrl}}/api/v1/workspaces/{{workspaceId}}/documents",
        bodyJson: {
          parentId: null,
          type: "document",
          name: "New Document",
          content: "# Hello RabbitPost",
        },
        docs: "新建目录或文档（editor+）；`type` 为 folder 时不传 `content`。",
      },
      {
        name: "Get document",
        method: "GET",
        url: "{{baseUrl}}/api/v1/documents/{{documentId}}",
        docs: "单个条目详情（含 Markdown 正文）。",
      },
      {
        name: "Update document",
        method: "PATCH",
        url: "{{baseUrl}}/api/v1/documents/{{documentId}}",
        bodyJson: { name: "Renamed Document", content: "# Updated content" },
        docs: "重命名 / 移动 / 排序 / 保存正文，editor+。",
      },
      {
        name: "Delete document",
        method: "DELETE",
        url: "{{baseUrl}}/api/v1/documents/{{documentId}}",
        docs: "删除条目（folder 连同子级一并删除），editor+。",
      },
    ],
  },
  {
    name: "Specs",
    description: "API 定义（OpenAPI / AsyncAPI）管理与生成 Collection。",
    requests: [
      {
        name: "List specs",
        method: "GET",
        url: "{{baseUrl}}/api/v1/workspaces/{{workspaceId}}/specs",
        docs: "返回 workspace 下全部 spec（不含定义正文）。",
      },
      {
        name: "Create spec",
        method: "POST",
        url: "{{baseUrl}}/api/v1/workspaces/{{workspaceId}}/specs",
        bodyJson: { name: "Demo Spec", type: "openapi-3.0", format: "yaml" },
        docs: "新建 spec（editor+）；`type` 可选 openapi-3.0 / openapi-3.1 / asyncapi-2.0，`content` 缺省时填充起始模板。",
      },
      {
        name: "Get spec",
        method: "GET",
        url: "{{baseUrl}}/api/v1/specs/{{specId}}",
        docs: "单个 spec 详情（含定义正文）。",
      },
      {
        name: "Update spec",
        method: "PATCH",
        url: "{{baseUrl}}/api/v1/specs/{{specId}}",
        bodyJson: { name: "Renamed Spec", format: "yaml", content: "openapi: 3.0.3\n..." },
        docs: "重命名 / 切换格式 / 保存定义正文，editor+。",
      },
      {
        name: "Delete spec",
        method: "DELETE",
        url: "{{baseUrl}}/api/v1/specs/{{specId}}",
        docs: "删除 spec，editor+。",
      },
      {
        name: "Generate collection from spec",
        method: "POST",
        url: "{{baseUrl}}/api/v1/specs/{{specId}}/generate-collection",
        bodyJson: { replaceLinked: false },
        docs: "由 OpenAPI 定义生成 Collection（editor+），端点按第一个 tag 分文件夹；`replaceLinked` 为 true 时覆盖已关联 Collection 的内容。AsyncAPI 不支持。",
      },
    ],
  },
  {
    name: "Environments",
    description: "环境与变量管理；变量在请求中以 {{varName}} 引用。",
    requests: [
      {
        name: "List environments",
        method: "GET",
        url: "{{baseUrl}}/api/v1/workspaces/{{workspaceId}}/environments",
        docs: "返回 workspace 下的环境列表（含变量）。",
      },
      {
        name: "Create environment",
        method: "POST",
        url: "{{baseUrl}}/api/v1/workspaces/{{workspaceId}}/environments",
        bodyJson: {
          name: "Local",
          variables: [
            {
              id: "var-1",
              key: "baseUrl",
              value: "http://localhost:4000",
              enabled: true,
              description: "RabbitPost API origin",
            },
          ],
        },
        docs: "新建环境（editor+）。",
      },
      {
        name: "Get environment",
        method: "GET",
        url: "{{baseUrl}}/api/v1/environments/{{environmentId}}",
        docs: "环境详情。",
      },
      {
        name: "Update environment",
        method: "PATCH",
        url: "{{baseUrl}}/api/v1/environments/{{environmentId}}",
        bodyJson: {
          name: "Local",
          variables: [
            { id: "var-1", key: "baseUrl", value: "http://localhost:4000", enabled: true },
          ],
        },
        docs: "更新名称 / 变量（变量整体替换），editor+。",
      },
      {
        name: "Delete environment",
        method: "DELETE",
        url: "{{baseUrl}}/api/v1/environments/{{environmentId}}",
        docs: "删除环境，editor+。",
      },
    ],
  },
  {
    name: "Execute & History",
    description: "服务端代理执行请求（避开浏览器 CORS）与请求历史。",
    requests: [
      {
        name: "Execute request",
        method: "POST",
        url: "{{baseUrl}}/api/v1/execute",
        bodyJson: {
          workspaceId: "{{workspaceId}}",
          environmentId: null,
          name: "Demo execute",
          request: {
            method: "GET",
            url: "https://httpbin.org/get",
            params: [],
            headers: [],
            body: { type: "none" },
            auth: { type: "none" },
            scripts: {},
          },
        },
        docs: "服务端代理执行 HTTP 请求并写入历史；viewer 也可调用。脚本输出与上游错误原文透传。",
      },
      {
        name: "List history",
        method: "GET",
        url: "{{baseUrl}}/api/v1/workspaces/{{workspaceId}}/history",
        params: [
          { key: "limit", value: "50", description: "单页条数，最大 200" },
          { key: "offset", value: "0", description: "偏移量" },
        ],
        docs: "按时间倒序返回请求历史。",
      },
      {
        name: "Clear history",
        method: "DELETE",
        url: "{{baseUrl}}/api/v1/workspaces/{{workspaceId}}/history",
        docs: "清空该 workspace 的请求历史，editor+。",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// 播种
// ---------------------------------------------------------------------------

/** workspace 下是否已存在同名 Demo Collection（回填脚本用，避免重复播种） */
export async function hasDemoCollection(workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(
        eq(collections.workspaceId, workspaceId),
        eq(collections.name, DEMO_COLLECTION_NAME),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** 在指定 workspace 播种 Demo Collection，返回新建的 collectionId */
export async function seedDemoCollection(workspaceId: string): Promise<string> {
  // 排在现有 Collection 末尾
  const [maxRow] = await db
    .select({ max: sql<number>`coalesce(max(${collections.sortOrder}), -1)` })
    .from(collections)
    .where(eq(collections.workspaceId, workspaceId));

  const [col] = await db
    .insert(collections)
    .values({
      workspaceId,
      name: DEMO_COLLECTION_NAME,
      description: DEMO_COLLECTION_DESCRIPTION,
      sortOrder: Number(maxRow?.max ?? -1) + 1,
    })
    .returning();
  if (!col) throw new Error("Failed to create demo collection");

  for (let f = 0; f < DEMO_FOLDERS.length; f++) {
    const folder = DEMO_FOLDERS[f]!;
    const [folderRow] = await db
      .insert(collectionItems)
      .values({
        collectionId: col.id,
        parentId: null,
        type: "folder",
        name: folder.name,
        description: folder.description,
        sortOrder: f,
      })
      .returning();
    if (!folderRow) throw new Error(`Failed to create demo folder ${folder.name}`);

    if (folder.requests.length > 0) {
      await db.insert(collectionItems).values(
        folder.requests.map((req, i) => ({
          collectionId: col.id,
          parentId: folderRow.id,
          type: "request" as const,
          name: req.name,
          sortOrder: i,
          request: toRequestConfig(req),
        })),
      );
    }
  }
  return col.id;
}
