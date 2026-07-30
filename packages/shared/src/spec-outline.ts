/**
 * spec 定义的结构化视图：
 * - buildSpecOutline：供 spec 编辑器右侧文档预览使用（对齐 Postman 的 API 文档面板）
 * - specToCollectionDraft：供「Generate collection」把 OpenAPI 端点转成 RabbitPost 请求
 */

import type { HttpMethod, KeyValueItem, RequestAuth, RequestConfig } from "./index";
import { isAsyncApi, parseSpecContent, type SpecType } from "./spec";

type Obj = Record<string, unknown>;

const HTTP_OPERATIONS: HttpMethod[] = [
  "GET",
  "PUT",
  "POST",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "PATCH",
];

function asObj(value: unknown): Obj | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

let kvSeq = 0;
function kvId(): string {
  return `kv-${Date.now()}-${kvSeq++}`;
}

function kv(key: string, value: string, enabled: boolean, description?: string): KeyValueItem {
  return { id: kvId(), key, value, enabled, description, type: "text" };
}

// ---------------------------------------------------------------------------
// $ref 解析与示例生成
// ---------------------------------------------------------------------------

/** 解析文档内部 $ref（形如 #/components/schemas/User）；外部引用不解析 */
function resolveRef(root: Obj, ref: string): Obj | null {
  if (!ref.startsWith("#/")) return null;
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    const obj = asObj(node);
    if (!obj) return null;
    node = obj[key];
  }
  return asObj(node);
}

/** 展开 schema 的 $ref / allOf，返回可直接读取 type & properties 的对象 */
function flattenSchema(schema: unknown, root: Obj, depth = 0): Obj | null {
  const obj = asObj(schema);
  if (!obj || depth > 8) return obj;
  const ref = asText(obj.$ref);
  if (ref !== "") {
    const target = resolveRef(root, ref);
    return target ? flattenSchema(target, root, depth + 1) : null;
  }
  const allOf = Array.isArray(obj.allOf) ? obj.allOf : null;
  if (allOf) {
    const merged: Obj = { type: "object", properties: {}, required: [] as string[] };
    for (const part of allOf) {
      const flat = flattenSchema(part, root, depth + 1);
      if (!flat) continue;
      Object.assign(merged.properties as Obj, asObj(flat.properties) ?? {});
      if (Array.isArray(flat.required)) {
        (merged.required as string[]).push(...(flat.required as string[]));
      }
    }
    return { ...obj, ...merged };
  }
  const variant = ["oneOf", "anyOf"].find((k) => Array.isArray(obj[k]));
  if (variant) {
    const first = (obj[variant] as unknown[])[0];
    return first ? flattenSchema(first, root, depth + 1) : obj;
  }
  return obj;
}

/** 由 schema 造一份示例值（example / default / enum 优先，其次按 type 取占位值） */
export function sampleFromSchema(schema: unknown, root: Obj, depth = 0): unknown {
  const flat = flattenSchema(schema, root, depth);
  if (!flat || depth > 6) return null;
  if (flat.example !== undefined) return flat.example;
  if (flat.default !== undefined) return flat.default;
  if (Array.isArray(flat.enum) && flat.enum.length > 0) return flat.enum[0];

  const type = Array.isArray(flat.type) ? asText(flat.type[0]) : asText(flat.type);
  const format = asText(flat.format);

  if (type === "object" || asObj(flat.properties)) {
    const out: Obj = {};
    for (const [key, prop] of Object.entries(asObj(flat.properties) ?? {})) {
      out[key] = sampleFromSchema(prop, root, depth + 1);
    }
    return out;
  }
  if (type === "array") return [sampleFromSchema(flat.items, root, depth + 1)];
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return true;
  if (type === "null") return null;
  if (format === "date-time") return "1970-01-01T00:00:00Z";
  if (format === "date") return "1970-01-01";
  if (format === "uuid") return "00000000-0000-0000-0000-000000000000";
  return type === "string" ? "string" : null;
}

/** schema 的单行摘要，如 array<User> / integer (default: 20) */
export function schemaLabel(schema: unknown, root: Obj, depth = 0): string {
  const obj = asObj(schema);
  if (!obj) return "";
  const ref = asText(obj.$ref);
  if (ref !== "") return ref.split("/").pop() ?? ref;
  const flat = flattenSchema(obj, root, depth) ?? obj;
  const type = Array.isArray(flat.type) ? (flat.type as unknown[]).map(asText).join("|") : asText(flat.type);
  if (type === "array") {
    const inner = schemaLabel(flat.items, root, depth + 1);
    return inner === "" ? "array" : `array<${inner}>`;
  }
  const parts = [type === "" ? "object" : type];
  if (asText(flat.format) !== "") parts.push(`(${asText(flat.format)})`);
  if (flat.default !== undefined) parts.push(`(default: ${JSON.stringify(flat.default)})`);
  return parts.join(" ");
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// 文档预览模型
// ---------------------------------------------------------------------------

export interface SpecParamDoc {
  name: string;
  in: string;
  required: boolean;
  description: string;
  schema: string;
}

export interface SpecResponseDoc {
  code: string;
  description: string;
  contentType: string;
  example: string;
}

export interface SpecOperationDoc {
  key: string;
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  description: string;
  deprecated: boolean;
  tags: string[];
  params: SpecParamDoc[];
  requestContentType: string;
  requestExample: string;
  responses: SpecResponseDoc[];
}

export interface SpecChannelOperationDoc {
  kind: "publish" | "subscribe";
  operationId: string;
  summary: string;
  payloadExample: string;
}

export interface SpecChannelDoc {
  name: string;
  description: string;
  operations: SpecChannelOperationDoc[];
}

export interface SpecSecurityDoc {
  name: string;
  type: string;
  detail: string;
}

export interface SpecOutline {
  title: string;
  version: string;
  description: string;
  servers: { url: string; description: string }[];
  tags: { name: string; description: string }[];
  operations: SpecOperationDoc[];
  channels: SpecChannelDoc[];
  security: SpecSecurityDoc[];
}

/** 解析定义并抽取文档预览所需信息；语法错误时返回 null */
export function buildSpecOutline(content: string, type: SpecType): SpecOutline | null {
  const { data } = parseSpecContent(content);
  if (!data) return null;
  const info = asObj(data.info) ?? {};
  const outline: SpecOutline = {
    title: asText(info.title),
    version: asText(info.version),
    description: asText(info.description),
    servers: [],
    tags: [],
    operations: [],
    channels: [],
    security: [],
  };

  for (const tag of Array.isArray(data.tags) ? data.tags : []) {
    const obj = asObj(tag);
    if (obj && asText(obj.name) !== "") {
      outline.tags.push({ name: asText(obj.name), description: asText(obj.description) });
    }
  }

  if (isAsyncApi(type)) {
    for (const [url, server] of Object.entries(asObj(data.servers) ?? {})) {
      const obj = asObj(server);
      outline.servers.push({
        url: asText(obj?.url) || url,
        description: asText(obj?.description) || asText(obj?.protocol),
      });
    }
    outline.channels = buildChannelDocs(data);
    return outline;
  }

  for (const server of Array.isArray(data.servers) ? data.servers : []) {
    const obj = asObj(server);
    if (obj && asText(obj.url) !== "") {
      outline.servers.push({ url: asText(obj.url), description: asText(obj.description) });
    }
  }
  outline.security = buildSecurityDocs(data);
  outline.operations = buildOperationDocs(data);
  return outline;
}

function buildSecurityDocs(root: Obj): SpecSecurityDoc[] {
  const schemes = asObj(asObj(root.components)?.securitySchemes) ?? {};
  return Object.entries(schemes).flatMap(([name, raw]) => {
    const scheme = asObj(raw);
    if (!scheme) return [];
    const type = asText(scheme.type);
    const detail =
      type === "http"
        ? `scheme: ${asText(scheme.scheme) || "-"}`
        : type === "apiKey"
          ? `${asText(scheme.in) || "header"}: ${asText(scheme.name)}`
          : type === "oauth2"
            ? Object.keys(asObj(scheme.flows) ?? {}).join(" / ")
            : asText(scheme.openIdConnectUrl);
    return [{ name, type, detail }];
  });
}

function buildOperationDocs(root: Obj): SpecOperationDoc[] {
  const operations: SpecOperationDoc[] = [];
  for (const [path, rawItem] of Object.entries(asObj(root.paths) ?? {})) {
    const pathItem = asObj(rawItem);
    if (!pathItem) continue;
    const sharedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of HTTP_OPERATIONS) {
      const operation = asObj(pathItem[method.toLowerCase()]);
      if (!operation) continue;
      const params = [
        ...sharedParams,
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ];
      const { contentType, example } = firstContent(operation.requestBody, root);
      operations.push({
        key: `${method} ${path}`,
        method,
        path,
        operationId: asText(operation.operationId),
        summary: asText(operation.summary),
        description: asText(operation.description),
        deprecated: operation.deprecated === true,
        tags: (Array.isArray(operation.tags) ? operation.tags : []).map(asText).filter(Boolean),
        params: params.flatMap((raw) => {
          const param = resolveMaybeRef(raw, root);
          if (!param || asText(param.name) === "") return [];
          return [
            {
              name: asText(param.name),
              in: asText(param.in) || "query",
              required: param.required === true,
              description: asText(param.description),
              schema: schemaLabel(param.schema, root),
            },
          ];
        }),
        requestContentType: contentType,
        requestExample: example,
        responses: Object.entries(asObj(operation.responses) ?? {}).map(([code, raw]) => {
          const response = resolveMaybeRef(raw, root) ?? {};
          const body = firstContent({ content: response.content }, root);
          return {
            code,
            description: asText(response.description),
            contentType: body.contentType,
            example: body.example,
          };
        }),
      });
    }
  }
  return operations;
}

function buildChannelDocs(root: Obj): SpecChannelDoc[] {
  return Object.entries(asObj(root.channels) ?? {}).map(([name, raw]) => {
    const channel = asObj(raw) ?? {};
    const operations: SpecChannelOperationDoc[] = [];
    for (const kind of ["publish", "subscribe"] as const) {
      const operation = asObj(channel[kind]);
      if (!operation) continue;
      const message = resolveMaybeRef(operation.message, root);
      const payload = message ? sampleFromSchema(message.payload, root) : null;
      operations.push({
        kind,
        operationId: asText(operation.operationId),
        summary: asText(operation.summary) || asText(operation.description),
        payloadExample: payload === null ? "" : jsonText(payload),
      });
    }
    return { name, description: asText(channel.description), operations };
  });
}

function resolveMaybeRef(value: unknown, root: Obj): Obj | null {
  const obj = asObj(value);
  if (!obj) return null;
  const ref = asText(obj.$ref);
  return ref === "" ? obj : resolveRef(root, ref);
}

/** 取 content 中优先级最高的媒体类型及其示例（json > urlencoded > form-data > 其它） */
function firstContent(
  holder: unknown,
  root: Obj,
): { contentType: string; example: string; schema: Obj | null } {
  const body = resolveMaybeRef(holder, root);
  const content = asObj(body?.content);
  if (!content) return { contentType: "", example: "", schema: null };
  const keys = Object.keys(content);
  const preferred =
    keys.find((k) => k.includes("json")) ??
    keys.find((k) => k.includes("x-www-form-urlencoded")) ??
    keys.find((k) => k.includes("form-data")) ??
    keys[0];
  if (!preferred) return { contentType: "", example: "", schema: null };
  const media = asObj(content[preferred]) ?? {};
  const schema = asObj(media.schema);
  const sample =
    media.example !== undefined
      ? media.example
      : firstNamedExample(media.examples) ?? sampleFromSchema(schema, root);
  const example =
    sample === null || sample === undefined
      ? ""
      : typeof sample === "string"
        ? sample
        : jsonText(sample);
  return { contentType: preferred, example, schema };
}

function firstNamedExample(examples: unknown): unknown {
  const obj = asObj(examples);
  if (!obj) return undefined;
  const first = Object.values(obj)[0];
  const wrapper = asObj(first);
  return wrapper && "value" in wrapper ? wrapper.value : first;
}

// ---------------------------------------------------------------------------
// Generate collection
// ---------------------------------------------------------------------------

export interface GeneratedRequestDraft {
  /** 所属文件夹名（按 tag 分组）；无 tag 时为 null，直接挂在 Collection 根下 */
  folder: string | null;
  name: string;
  config: RequestConfig;
}

export interface GeneratedCollectionDraft {
  name: string;
  description: string;
  /** 需要创建的文件夹，按出现顺序 */
  folders: string[];
  requests: GeneratedRequestDraft[];
}

/**
 * 把 OpenAPI 定义转成可直接创建的 Collection 草稿：
 * 文件夹按第一个 tag 分组（无 tag 时回落到 path 首段），URL 取第一个 server 前缀，
 * path 占位符 {id} 转为 {{id}} 以便用环境变量填充。
 */
export function specToCollectionDraft(
  content: string,
  type: SpecType,
  fallbackName: string,
): GeneratedCollectionDraft {
  const { data } = parseSpecContent(content);
  if (!data || isAsyncApi(type)) {
    return { name: fallbackName, description: "", folders: [], requests: [] };
  }
  const info = asObj(data.info) ?? {};
  const servers = Array.isArray(data.servers) ? data.servers : [];
  const baseUrl = asText(asObj(servers[0])?.url).replace(/\/+$/, "");
  const schemes = asObj(asObj(data.components)?.securitySchemes) ?? {};
  const rootSecurity = Array.isArray(data.security) ? data.security : [];

  const folders: string[] = [];
  const requests: GeneratedRequestDraft[] = [];

  for (const operation of buildOperationDocs(data)) {
    const raw = asObj(asObj(asObj(data.paths)?.[operation.path])?.[operation.method.toLowerCase()]) ?? {};
    const folder =
      operation.tags[0] ?? operation.path.split("/").filter(Boolean)[0] ?? null;
    if (folder && !folders.includes(folder)) folders.push(folder);

    const params: KeyValueItem[] = [];
    const headers: KeyValueItem[] = [];
    for (const param of operation.params) {
      if (param.in === "query") {
        params.push(kv(param.name, "", param.required, param.description));
      } else if (param.in === "header") {
        headers.push(kv(param.name, "", param.required, param.description));
      }
    }

    const config: RequestConfig = {
      protocol: "http",
      method: operation.method,
      url: `${baseUrl}${operation.path.replace(/\{([^}]+)\}/g, "{{$1}}")}`,
      params,
      headers,
      body: buildBody(raw.requestBody, data),
      auth: buildAuth(
        Array.isArray(raw.security) ? raw.security : rootSecurity,
        schemes,
      ),
      scripts: {},
      docs: operation.description || operation.summary,
    };

    requests.push({
      folder,
      name: operation.summary || operation.operationId || operation.key,
      config,
    });
  }

  return {
    name: asText(info.title) || fallbackName,
    description: asText(info.description),
    folders,
    requests,
  };
}

function buildBody(requestBody: unknown, root: Obj): RequestConfig["body"] {
  const { contentType, example, schema } = firstContent(requestBody, root);
  if (contentType === "") return { type: "none", rawLanguage: "json" };
  if (contentType.includes("x-www-form-urlencoded") || contentType.includes("form-data")) {
    const flat = flattenSchema(schema, root);
    const properties = asObj(flat?.properties) ?? {};
    const required = new Set(
      (Array.isArray(flat?.required) ? flat!.required : []).map(asText),
    );
    const items = Object.entries(properties).map(([name, prop]) =>
      kv(name, "", required.has(name), asText(asObj(prop)?.description)),
    );
    return contentType.includes("form-data")
      ? { type: "form-data", rawLanguage: "json", formData: items }
      : { type: "x-www-form-urlencoded", rawLanguage: "json", urlencoded: items };
  }
  const rawLanguage = contentType.includes("json")
    ? "json"
    : contentType.includes("xml")
      ? "xml"
      : contentType.includes("html")
        ? "html"
        : "text";
  return { type: "raw", rawLanguage, raw: example };
}

/** 由 security requirement + securitySchemes 推断请求级 auth（仅映射可无歧义对应的类型） */
function buildAuth(security: unknown[], schemes: Obj): RequestAuth {
  for (const requirement of security) {
    for (const name of Object.keys(asObj(requirement) ?? {})) {
      const scheme = asObj(schemes[name]);
      if (!scheme) continue;
      const type = asText(scheme.type);
      const httpScheme = asText(scheme.scheme).toLowerCase();
      if (type === "http" && httpScheme === "bearer") return { type: "bearer", bearer: {} };
      if (type === "http" && httpScheme === "basic") return { type: "basic", basic: {} };
      if (type === "http" && httpScheme === "digest") return { type: "digest", digest: {} };
      if (type === "apiKey") {
        return {
          type: "api-key",
          apiKey: {
            key: asText(scheme.name),
            in: asText(scheme.in) === "query" ? "query" : "header",
          },
        };
      }
      if (type === "oauth2" || type === "openIdConnect") {
        return { type: "oauth2", oauth2: {} };
      }
    }
  }
  return { type: "none" };
}
