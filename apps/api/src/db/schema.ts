import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  EnvironmentVariable,
  HistoryResponseSummary,
  RequestConfig,
  SpecFormat,
  SpecType,
  TeamRole,
} from "@rabbitpost/shared";

// ---------------------------------------------------------------------------
// users：由 Casdoor 登录后自动同步（upsert）
// ---------------------------------------------------------------------------
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    casdoorId: text("casdoor_id").notNull(),
    name: text("name").notNull(),
    email: text("email"),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("users_casdoor_id_idx").on(t.casdoorId)],
);

// ---------------------------------------------------------------------------
// teams & team_members
// ---------------------------------------------------------------------------
export const teams = pgTable(
  "teams",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    avatarUrl: text("avatar_url"),
    createdBy: uuid("created_by")
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("teams_slug_idx").on(t.slug)],
);

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id")
      .references(() => teams.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    role: text("role").$type<TeamRole>().notNull().default("editor"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

// ---------------------------------------------------------------------------
// workspaces
// ---------------------------------------------------------------------------
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamId: uuid("team_id")
      .references(() => teams.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdBy: uuid("created_by")
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("workspaces_team_idx").on(t.teamId)],
);

// ---------------------------------------------------------------------------
// collections & collection_items（自引用树：folder / request）
// ---------------------------------------------------------------------------
export const collections = pgTable(
  "collections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** 侧边栏手动拖拽排序 */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("collections_workspace_idx").on(t.workspaceId)],
);

export const collectionItems = pgTable(
  "collection_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    collectionId: uuid("collection_id")
      .references(() => collections.id, { onDelete: "cascade" })
      .notNull(),
    parentId: uuid("parent_id"),
    type: text("type").$type<"folder" | "request">().notNull(),
    name: text("name").notNull(),
    /** 文件夹 Overview 文档（Markdown） */
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** 仅 type = request 时有值，保存完整请求配置 */
    request: jsonb("request").$type<RequestConfig>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("collection_items_collection_idx").on(t.collectionId)],
);

// ---------------------------------------------------------------------------
// document_items（workspace 级自引用树：folder / document）
// ---------------------------------------------------------------------------
export const documentItems = pgTable(
  "document_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    parentId: uuid("parent_id"),
    type: text("type").$type<"folder" | "document">().notNull(),
    name: text("name").notNull(),
    /** 文档正文（Markdown）；仅 type = document 时有值 */
    content: text("content"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("document_items_workspace_idx").on(t.workspaceId)],
);

// ---------------------------------------------------------------------------
// specs（workspace 级 API 定义：OpenAPI / AsyncAPI）
// ---------------------------------------------------------------------------
export const specs = pgTable(
  "specs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    type: text("type").$type<SpecType>().notNull(),
    format: text("format").$type<SpecFormat>().notNull().default("yaml"),
    /** 定义正文（YAML 或 JSON 文本） */
    content: text("content").notNull().default(""),
    /** 由该 spec 生成的 Collection；Collection 被删除后置空 */
    generatedCollectionId: uuid("generated_collection_id").references(
      () => collections.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("specs_workspace_idx").on(t.workspaceId)],
);

// ---------------------------------------------------------------------------
// environments
// ---------------------------------------------------------------------------
export const environments = pgTable(
  "environments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    variables: jsonb("variables")
      .$type<EnvironmentVariable[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("environments_workspace_idx").on(t.workspaceId)],
);

// ---------------------------------------------------------------------------
// histories
// ---------------------------------------------------------------------------
export const histories = pgTable(
  "histories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    name: text("name"),
    request: jsonb("request").$type<RequestConfig>().notNull(),
    response: jsonb("response").$type<HistoryResponseSummary>(),
    /** 网络层错误原文透传 */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("histories_workspace_created_idx").on(t.workspaceId, t.createdAt)],
);
