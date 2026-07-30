/**
 * spec 定义校验（对齐 Postman spec 编辑器的 Issues 面板）。
 * 规则名沿用 Spectral 的 OpenAPI / AsyncAPI 规则名，方便与 Postman 的提示逐条对照。
 */

import {
  isAsyncApi,
  parseSpecContent,
  type SpecIssue,
  type SpecIssueSeverity,
  type SpecType,
} from "./spec";

type Obj = Record<string, unknown>;

const HTTP_OPERATIONS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

const PARAMETER_LOCATIONS = ["path", "query", "header", "cookie"] as const;

function asObj(value: unknown): Obj | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 路径段拼成 Postman 风格的定位串，如 paths./users.get.responses */
function pathLabel(path: (string | number)[]): string {
  return path.join(".");
}

/** 提取 URL 模板中的 {param} 占位符 */
export function templateParams(template: string): string[] {
  return [...template.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!);
}

/** 递归收集定义中出现的所有 $ref 目标，用于未使用组件检测 */
function collectRefs(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectRefs(child, out);
    return;
  }
  const obj = asObj(value);
  if (!obj) return;
  for (const [key, child] of Object.entries(obj)) {
    if (key === "$ref" && typeof child === "string") out.add(child);
    else collectRefs(child, out);
  }
}

/** 校验定义正文，返回 Issues（错误优先、其次按行号升序） */
export function validateSpec(content: string, type: SpecType): SpecIssue[] {
  if (content.trim() === "") {
    return [
      {
        severity: "error",
        rule: "spec-syntax",
        message: "定义内容为空",
        path: "",
        line: 1,
        column: 1,
      },
    ];
  }

  const { data, syntaxIssues, locate } = parseSpecContent(content);
  if (syntaxIssues.length > 0 || !data) return syntaxIssues;

  const issues: SpecIssue[] = [];
  const add = (
    severity: SpecIssueSeverity,
    rule: string,
    message: string,
    path: (string | number)[],
  ) => {
    issues.push({ severity, rule, message, path: pathLabel(path), ...locate(path) });
  };

  validateInfo(data, type, add);
  if (isAsyncApi(type)) validateAsyncApi(data, add);
  else validateOpenApi(data, type, add);

  const severityRank = (s: SpecIssueSeverity) => (s === "error" ? 0 : 1);
  return issues.sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.line - b.line,
  );
}

type AddIssue = (
  severity: SpecIssueSeverity,
  rule: string,
  message: string,
  path: (string | number)[],
) => void;

/** 版本字段与 info 对象：OpenAPI / AsyncAPI 共用 */
function validateInfo(data: Obj, type: SpecType, add: AddIssue): void {
  const async = isAsyncApi(type);
  const versionKey = async ? "asyncapi" : "openapi";
  const expectedPrefix = async ? "2." : type === "openapi-3.1" ? "3.1" : "3.0";
  const schemaRule = async ? "asyncapi-schema" : "oas3-schema";
  const version = asText(data[versionKey]);

  if (version === "") {
    add("error", schemaRule, `定义缺少必填字段「${versionKey}」`, []);
  } else if (!version.startsWith(expectedPrefix)) {
    add(
      "error",
      "spec-type-mismatch",
      `${versionKey}: ${version} 与当前 spec 类型（要求 ${expectedPrefix}x）不一致`,
      [versionKey],
    );
  }

  const info = asObj(data.info);
  if (!info) {
    add("error", schemaRule, "定义缺少必填字段「info」", []);
    return;
  }
  if (asText(info.title) === "") {
    add("error", schemaRule, "info 缺少必填字段「title」", ["info"]);
  }
  if (asText(info.version) === "") {
    add("error", schemaRule, "info 缺少必填字段「version」", ["info"]);
  }
  if (asText(info.description) === "") {
    add(
      "warning",
      async ? "asyncapi-info-description" : "info-description",
      "info 建议提供 description",
      ["info"],
    );
  }
  if (!asObj(info.contact)) {
    add(
      "warning",
      async ? "asyncapi-info-contact" : "info-contact",
      "info 建议提供 contact 对象",
      ["info"],
    );
  }
  const license = asObj(info.license);
  if (license && asText(license.url) === "" && asText(license.identifier) === "") {
    add("warning", "license-url", "license 建议提供 url", ["info", "license"]);
  }
}

// ---------------------------------------------------------------------------
// OpenAPI
// ---------------------------------------------------------------------------

function validateOpenApi(data: Obj, type: SpecType, add: AddIssue): void {
  const servers = asArray(data.servers);
  if (!servers || servers.length === 0) {
    add("warning", "oas3-api-servers", "定义建议提供非空的 servers 列表", []);
  } else {
    servers.forEach((server, i) => {
      const obj = asObj(server);
      if (!obj || asText(obj.url) === "") {
        add("error", "oas3-schema", "server 缺少必填字段「url」", ["servers", i]);
      }
    });
  }

  const definedTags = new Set<string>();
  const tags = asArray(data.tags);
  if (!tags || tags.length === 0) {
    add("warning", "openapi-tags", "定义建议提供非空的 tags 列表", []);
  } else {
    tags.forEach((tag, i) => {
      const obj = asObj(tag);
      const name = asText(obj?.name);
      if (name === "") {
        add("error", "oas3-schema", "tag 缺少必填字段「name」", ["tags", i]);
        return;
      }
      definedTags.add(name);
      if (asText(obj?.description) === "") {
        add("warning", "tag-description", `tag「${name}」建议提供 description`, [
          "tags",
          i,
        ]);
      }
    });
  }

  const paths = asObj(data.paths);
  const pathCount = paths ? Object.keys(paths).length : 0;
  if (pathCount === 0) {
    const hasWebhooks = Object.keys(asObj(data.webhooks) ?? {}).length > 0;
    if (type === "openapi-3.1" && hasWebhooks) {
      // 3.1 允许只描述 webhooks
    } else if (type === "openapi-3.1") {
      add("warning", "oas3-schema", "定义未包含任何 paths 或 webhooks", []);
    } else {
      add("error", "oas3-schema", "定义缺少必填字段「paths」", []);
    }
  }

  const operationIds = new Map<string, (string | number)[]>();
  for (const [pathKey, pathValue] of Object.entries(paths ?? {})) {
    validatePathItem(pathKey, pathValue, definedTags, operationIds, add);
  }

  validateUnusedComponents(data, add);
}

function validatePathItem(
  pathKey: string,
  pathValue: unknown,
  definedTags: Set<string>,
  operationIds: Map<string, (string | number)[]>,
  add: AddIssue,
): void {
  const base: (string | number)[] = ["paths", pathKey];
  if (!pathKey.startsWith("/")) {
    add("error", "oas3-schema", `path「${pathKey}」必须以 / 开头`, base);
  }
  if (pathKey.length > 1 && pathKey.endsWith("/")) {
    add("warning", "path-keys-no-trailing-slash", `path「${pathKey}」不应以 / 结尾`, base);
  }
  if (pathKey.includes("?")) {
    add("error", "path-not-include-query", `path「${pathKey}」不能包含 query 串`, base);
  }
  const declared = templateParams(pathKey);
  if (declared.some((name) => name.trim() === "")) {
    add("error", "path-declarations-must-exist", `path「${pathKey}」含空的 {} 占位符`, base);
  }

  const pathItem = asObj(pathValue);
  if (!pathItem) {
    add("error", "oas3-schema", `path「${pathKey}」的值必须是对象`, base);
    return;
  }

  const pathLevelParams = collectParameters(pathItem.parameters, base, add);

  for (const method of HTTP_OPERATIONS) {
    const operation = asObj(pathItem[method]);
    if (!operation) continue;
    const opPath = [...base, method];

    const operationId = asText(operation.operationId);
    if (operationId === "") {
      add("warning", "operation-operationId", "操作建议提供 operationId", opPath);
    } else if (operationIds.has(operationId)) {
      add(
        "error",
        "operation-operationId-unique",
        `operationId「${operationId}」重复（另见 ${pathLabel(operationIds.get(operationId)!)}）`,
        opPath,
      );
    } else {
      operationIds.set(operationId, opPath);
    }

    if (asText(operation.summary) === "" && asText(operation.description) === "") {
      add("warning", "operation-description", "操作建议提供 summary 或 description", opPath);
    }

    const opTags = asArray(operation.tags) ?? [];
    if (opTags.length === 0) {
      add("warning", "operation-tags", "操作建议提供 tags", opPath);
    } else {
      opTags.forEach((tag) => {
        const name = asText(tag);
        if (name !== "" && !definedTags.has(name)) {
          add(
            "warning",
            "operation-tag-defined",
            `操作使用的 tag「${name}」未在根级 tags 中定义`,
            opPath,
          );
        }
      });
    }

    const responses = asObj(operation.responses);
    if (!responses || Object.keys(responses).length === 0) {
      add("error", "operation-responses", "操作缺少必填字段「responses」", opPath);
    } else {
      for (const [code, response] of Object.entries(responses)) {
        const resObj = asObj(response);
        if (resObj && "$ref" in resObj) continue;
        if (!resObj || asText(resObj.description) === "") {
          add("error", "oas3-schema", `响应「${code}」缺少必填字段「description」`, [
            ...opPath,
            "responses",
            code,
          ]);
        }
      }
    }

    const opParams = collectParameters(operation.parameters, opPath, add);
    const effective = [...pathLevelParams, ...opParams];
    const pathParamNames = new Set(
      effective.filter((p) => p.in === "path").map((p) => p.name),
    );
    for (const name of declared) {
      if (name.trim() !== "" && !pathParamNames.has(name)) {
        add(
          "error",
          "path-params",
          `path 占位符「{${name}}」未声明为 in: path 参数`,
          opPath,
        );
      }
    }
    for (const param of effective) {
      if (param.in === "path" && !declared.includes(param.name)) {
        add(
          "error",
          "path-params",
          `参数「${param.name}」声明为 in: path，但 path「${pathKey}」中没有对应占位符`,
          opPath,
        );
      }
    }
  }
}

interface CollectedParam {
  name: string;
  in: string;
}

/** 校验 parameters 数组并返回其中可用于 path 占位符匹配的条目 */
function collectParameters(
  value: unknown,
  base: (string | number)[],
  add: AddIssue,
): CollectedParam[] {
  const arr = asArray(value);
  if (!arr) return [];
  const result: CollectedParam[] = [];
  arr.forEach((raw, i) => {
    const obj = asObj(raw);
    const paramPath = [...base, "parameters", i];
    if (!obj) {
      add("error", "oas3-schema", "parameters 条目必须是对象", paramPath);
      return;
    }
    // $ref 引用的参数不在此处展开校验
    if ("$ref" in obj) return;
    const name = asText(obj.name);
    const location = asText(obj.in);
    if (name === "") add("error", "oas3-schema", "参数缺少必填字段「name」", paramPath);
    if (location === "") {
      add("error", "oas3-schema", "参数缺少必填字段「in」", paramPath);
    } else if (!(PARAMETER_LOCATIONS as readonly string[]).includes(location)) {
      add(
        "error",
        "oas3-schema",
        `参数 in「${location}」非法，可选值：${PARAMETER_LOCATIONS.join(" / ")}`,
        paramPath,
      );
    }
    if (location === "path" && obj.required !== true) {
      add("error", "path-params", `path 参数「${name}」必须声明 required: true`, paramPath);
    }
    if (!asObj(obj.schema) && !asObj(obj.content)) {
      add("warning", "oas3-schema", `参数「${name}」建议提供 schema`, paramPath);
    }
    if (name !== "" && location !== "") result.push({ name, in: location });
  });
  return result;
}

function validateUnusedComponents(data: Obj, add: AddIssue): void {
  const schemas = asObj(asObj(data.components)?.schemas);
  if (!schemas) return;
  const refs = new Set<string>();
  collectRefs(data, refs);
  for (const name of Object.keys(schemas)) {
    if (!refs.has(`#/components/schemas/${name}`)) {
      add("warning", "oas3-unused-component", `组件 schema「${name}」未被引用`, [
        "components",
        "schemas",
        name,
      ]);
    }
  }
}

// ---------------------------------------------------------------------------
// AsyncAPI
// ---------------------------------------------------------------------------

function validateAsyncApi(data: Obj, add: AddIssue): void {
  const servers = asObj(data.servers);
  if (!servers || Object.keys(servers).length === 0) {
    add("warning", "asyncapi-servers", "定义建议提供非空的 servers", []);
  } else {
    for (const [name, server] of Object.entries(servers)) {
      const obj = asObj(server);
      if (!obj || asText(obj.url) === "") {
        add("error", "asyncapi-schema", `server「${name}」缺少必填字段「url」`, [
          "servers",
          name,
        ]);
      }
      if (obj && asText(obj.protocol) === "") {
        add("error", "asyncapi-schema", `server「${name}」缺少必填字段「protocol」`, [
          "servers",
          name,
        ]);
      }
    }
  }

  const channels = asObj(data.channels);
  if (!channels || Object.keys(channels).length === 0) {
    add("error", "asyncapi-schema", "定义缺少必填字段「channels」", []);
    return;
  }

  for (const [channelName, channelValue] of Object.entries(channels)) {
    const base: (string | number)[] = ["channels", channelName];
    const channel = asObj(channelValue);
    if (!channel) {
      add("error", "asyncapi-schema", `channel「${channelName}」的值必须是对象`, base);
      continue;
    }
    const operations = (["publish", "subscribe"] as const).filter((k) =>
      asObj(channel[k]),
    );
    if (operations.length === 0) {
      add(
        "error",
        "asyncapi-channel-operations",
        `channel「${channelName}」至少需要 publish 或 subscribe`,
        base,
      );
    }
    for (const kind of operations) {
      const operation = asObj(channel[kind])!;
      const opPath = [...base, kind];
      if (asText(operation.operationId) === "") {
        add(
          "warning",
          "asyncapi-operation-operationId",
          `${kind} 操作建议提供 operationId`,
          opPath,
        );
      }
      if (asText(operation.summary) === "" && asText(operation.description) === "") {
        add(
          "warning",
          "asyncapi-operation-description",
          `${kind} 操作建议提供 summary 或 description`,
          opPath,
        );
      }
      if (!asObj(operation.message)) {
        add("warning", "asyncapi-message-payload", `${kind} 操作建议提供 message`, opPath);
      }
    }

    const declaredParams = Object.keys(asObj(channel.parameters) ?? {});
    for (const name of templateParams(channelName)) {
      if (!declaredParams.includes(name)) {
        add(
          "error",
          "asyncapi-channel-parameters",
          `channel 占位符「{${name}}」未在 parameters 中声明`,
          base,
        );
      }
    }
  }
}
