/**
 * Specs 模块（对齐 Postman Specs）：类型定义、起始模板、定义解析与校验。
 * 校验规则名沿用 Spectral OpenAPI/AsyncAPI 规则名，便于与 Postman Issues 面板对照。
 */

import { LineCounter, parseDocument, stringify } from "yaml";

// ---------------------------------------------------------------------------
// Enums & entities
// ---------------------------------------------------------------------------

/** spec 定义类型；顺序与 Postman「Create spec」下拉一致 */
export const SPEC_TYPES = ["openapi-3.0", "openapi-3.1", "asyncapi-2.0"] as const;
export type SpecType = (typeof SPEC_TYPES)[number];

export const SPEC_TYPE_LABELS: Record<SpecType, string> = {
  "openapi-3.0": "OpenAPI 3.0",
  "openapi-3.1": "OpenAPI 3.1",
  "asyncapi-2.0": "AsyncAPI 2.0",
};

export const SPEC_FORMATS = ["yaml", "json"] as const;
export type SpecFormat = (typeof SPEC_FORMATS)[number];

export const SPEC_FORMAT_LABELS: Record<SpecFormat, string> = {
  yaml: "YAML",
  json: "JSON",
};

export interface Spec {
  id: string;
  workspaceId: string;
  name: string;
  type: SpecType;
  format: SpecFormat;
  /** 定义正文（YAML 或 JSON 文本） */
  content: string;
  /** 由该 spec 生成的 Collection（Postman: linked collection）；被删除后回落为 null */
  generatedCollectionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SpecIssueSeverity = "error" | "warning";

/** 校验结果条目；对应 Postman spec 编辑器底部 Issues 列表的一行 */
export interface SpecIssue {
  severity: SpecIssueSeverity;
  /** 规则名（Spectral 规则名，如 oas3-schema / operation-operationId） */
  rule: string;
  message: string;
  /** 定义内路径，如 paths./pets.get.responses；根节点为空串 */
  path: string;
  /** 1-based 行号，用于点击跳转 */
  line: number;
  column: number;
}

export function isSpecType(value: unknown): value is SpecType {
  return typeof value === "string" && (SPEC_TYPES as readonly string[]).includes(value);
}

/** AsyncAPI 用 channels 描述消息通道，OpenAPI 用 paths 描述 HTTP 端点 */
export function isAsyncApi(type: SpecType): boolean {
  return type === "asyncapi-2.0";
}

// ---------------------------------------------------------------------------
// 起始模板（新建 spec 时的默认定义，校验零 issue）
// ---------------------------------------------------------------------------

function openApiTemplate(name: string, version: "3.0.3" | "3.1.0"): string {
  return `openapi: ${version}
info:
  title: ${name}
  version: 1.0.0
  description: ${name} 的接口定义。
  contact:
    name: API Support
    email: support@example.com
servers:
  - url: https://api.example.com/v1
    description: Production
tags:
  - name: users
    description: 用户相关接口
paths:
  /users:
    get:
      tags:
        - users
      operationId: listUsers
      summary: List users
      description: 分页返回用户列表。
      parameters:
        - name: limit
          in: query
          required: false
          description: 单页条数
          schema:
            type: integer
            default: 20
      responses:
        "200":
          description: 用户列表
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/User"
components:
  schemas:
    User:
      type: object
      required:
        - id
        - name
      properties:
        id:
          type: string
          description: 用户 ID
        name:
          type: string
          description: 用户名
`;
}

function asyncApiTemplate(name: string): string {
  return `asyncapi: 2.0.0
info:
  title: ${name}
  version: 1.0.0
  description: ${name} 的消息定义。
  contact:
    name: API Support
    email: support@example.com
servers:
  production:
    url: broker.example.com
    protocol: mqtt
    description: Production broker
channels:
  user/signedup:
    description: 用户注册后广播的消息
    subscribe:
      operationId: onUserSignedUp
      summary: 接收用户注册事件
      message:
        payload:
          type: object
          properties:
            id:
              type: string
            name:
              type: string
`;
}

/** 新建 spec 的起始定义；JSON 格式时转成等价 JSON 文本 */
export function createDefaultSpecContent(
  type: SpecType,
  name: string,
  format: SpecFormat = "yaml",
): string {
  const title = name.trim() || "New Spec";
  const yaml =
    type === "asyncapi-2.0"
      ? asyncApiTemplate(title)
      : openApiTemplate(title, type === "openapi-3.1" ? "3.1.0" : "3.0.3");
  return format === "json" ? convertSpecFormat(yaml, "json") : yaml;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export interface SpecPosition {
  line: number;
  column: number;
}

export interface ParsedSpec {
  /** 解析结果；语法错误导致无法解析时为 null */
  data: Record<string, unknown> | null;
  /** YAML / JSON 语法错误 */
  syntaxIssues: SpecIssue[];
  /** 按定义内路径定位行列；找不到精确节点时回落到最近的祖先 */
  locate: (path: (string | number)[]) => SpecPosition;
}

/** 解析定义正文（YAML 1.2 是 JSON 的超集，两种格式共用解析器） */
export function parseSpecContent(content: string): ParsedSpec {
  const lineCounter = new LineCounter();
  const doc = parseDocument(content, { lineCounter, uniqueKeys: true });

  const posOf = (offset: number | undefined): SpecPosition => {
    if (offset === undefined) return { line: 1, column: 1 };
    const { line, col } = lineCounter.linePos(offset);
    return { line, column: col };
  };

  const syntaxIssues: SpecIssue[] = doc.errors.map((e) => ({
    severity: "error" as const,
    rule: "spec-syntax",
    message: e.message,
    path: "",
    ...posOf(e.pos[0]),
  }));

  let data: Record<string, unknown> | null = null;
  if (syntaxIssues.length === 0) {
    try {
      const js: unknown = doc.toJS();
      data = js !== null && typeof js === "object" && !Array.isArray(js)
        ? (js as Record<string, unknown>)
        : null;
      if (js !== null && data === null) {
        syntaxIssues.push({
          severity: "error",
          rule: "spec-syntax",
          message: "定义根节点必须是对象",
          path: "",
          line: 1,
          column: 1,
        });
      }
    } catch (e) {
      syntaxIssues.push({
        severity: "error",
        rule: "spec-syntax",
        message: e instanceof Error ? e.message : String(e),
        path: "",
        line: 1,
        column: 1,
      });
    }
  }

  const locate = (path: (string | number)[]): SpecPosition => {
    for (let i = path.length; i >= 0; i--) {
      const node: unknown = i === 0 ? doc.contents : doc.getIn(path.slice(0, i), true);
      const range = (node as { range?: [number, number, number] } | null)?.range;
      if (range) return posOf(range[0]);
    }
    return { line: 1, column: 1 };
  };

  return { data, syntaxIssues, locate };
}

/** YAML ↔ JSON 互转（保留语义，用于 spec 格式切换与格式化） */
export function convertSpecFormat(content: string, target: SpecFormat): string {
  const doc = parseDocument(content, { uniqueKeys: false });
  if (doc.errors.length > 0) return content;
  let value: unknown;
  try {
    value = doc.toJS();
  } catch {
    return content;
  }
  if (target === "json") return `${JSON.stringify(value, null, 2)}\n`;
  // 注意：不能用 doc.toString() —— JSON 解析出的节点是 flow 风格，
  // 原样序列化会得到 JSON 外观的单行输出（表现为“切不回 YAML”）；
  // 先 toJS 再 stringify 才能生成块状 YAML。
  return stringify(value, { indent: 2, lineWidth: 0 });
}
