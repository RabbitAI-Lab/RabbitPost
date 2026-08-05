/**
 * Specs 模块核心逻辑单测：
 * - spec.ts：起始模板、定义解析、YAML/JSON 互转
 * - spec-validate.ts：Spectral 风格校验规则
 * - spec-outline.ts：文档预览模型与 Generate collection 草稿
 */
import { describe, expect, it } from "vitest";
import {
  buildSpecOutline,
  convertSpecFormat,
  createDefaultSpecContent,
  isAsyncApi,
  isSpecType,
  parseSpecContent,
  sampleFromSchema,
  schemaLabel,
  SPEC_TYPES,
  specToCollectionDraft,
  validateSpec,
} from "../src/index";

/** 一份零 issue 的 OpenAPI 3.0 定义（含 query/path 参数、$ref、POST body） */
const PET_SPEC = `openapi: 3.0.3
info:
  title: Pet API
  version: 1.0.0
  description: Pet store.
  contact:
    name: Support
servers:
  - url: https://api.example.com/v1
tags:
  - name: pets
    description: Pet endpoints
paths:
  /pets:
    get:
      tags: [pets]
      operationId: listPets
      summary: List pets
      parameters:
        - name: limit
          in: query
          required: false
          schema:
            type: integer
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/Pet"
    post:
      tags: [pets]
      operationId: createPet
      summary: Create pet
      requestBody:
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Pet"
            example:
              id: "42"
              name: tom
      responses:
        "201":
          description: created
  /pets/{petId}:
    get:
      tags: [pets]
      operationId: getPet
      summary: Get a pet
      parameters:
        - name: petId
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Pet"
components:
  schemas:
    Pet:
      type: object
      required: [id, name]
      properties:
        id:
          type: string
        name:
          type: string
          example: tom
`;

const rulesOf = (issues: ReturnType<typeof validateSpec>) => issues.map((i) => i.rule);
const errorsOf = (issues: ReturnType<typeof validateSpec>) =>
  issues.filter((i) => i.severity === "error").map((i) => i.rule);

describe("spec.ts 基础能力", () => {
  it("isSpecType / isAsyncApi 枚举判断", () => {
    expect(isSpecType("openapi-3.0")).toBe(true);
    expect(isSpecType("openapi-9.9")).toBe(false);
    expect(isAsyncApi("asyncapi-2.0")).toBe(true);
    expect(isAsyncApi("openapi-3.1")).toBe(false);
  });

  it("三种类型的起始模板均校验零 issue（yaml 与 json 格式）", () => {
    for (const type of SPEC_TYPES) {
      for (const format of ["yaml", "json"] as const) {
        const content = createDefaultSpecContent(type, "Demo", format);
        const issues = validateSpec(content, type);
        expect(issues, `${type} ${format}: ${JSON.stringify(issues)}`).toEqual([]);
      }
    }
  });

  it("空名称回落到 New Spec 标题", () => {
    const yaml = createDefaultSpecContent("openapi-3.0", "   ");
    expect(yaml).toContain("title: New Spec");
  });

  it("parseSpecContent 正常解析并支持路径定位", () => {
    const { data, syntaxIssues, locate } = parseSpecContent(PET_SPEC);
    expect(syntaxIssues).toEqual([]);
    expect((data?.info as { title: string }).title).toBe("Pet API");
    const pos = locate(["paths", "/pets/{petId}"]);
    const lines = PET_SPEC.split("\n");
    const keyLine = lines.findIndex((l) => l.includes("/pets/{petId}")) + 1;
    // 定位允许落在键所在行或其值节点首行（回落到最近可定位节点）
    expect(pos.line >= keyLine && pos.line <= keyLine + 1).toBe(true);
  });

  it("parseSpecContent 报告 YAML 语法错误且不产出 data", () => {
    const { data, syntaxIssues } = parseSpecContent("a: [1, 2");
    expect(data).toBeNull();
    expect(syntaxIssues.length).toBeGreaterThan(0);
    expect(syntaxIssues[0]!.rule).toBe("spec-syntax");
  });

  it("parseSpecContent 拒绝重复键与非对象根节点", () => {
    expect(parseSpecContent("a: 1\na: 2").syntaxIssues.length).toBeGreaterThan(0);
    const arr = parseSpecContent("- 1\n- 2");
    expect(arr.data).toBeNull();
    expect(arr.syntaxIssues[0]!.message).toBe("定义根节点必须是对象");
  });

  it("convertSpecFormat YAML→JSON→YAML 语义等价", () => {
    const json = convertSpecFormat(PET_SPEC, "json");
    expect(JSON.parse(json).info.title).toBe("Pet API");

    const yaml = convertSpecFormat(json, "yaml");
    // 不能是 JSON 外观的单行输出（历史 bug 回归点）
    expect(yaml).toContain("openapi:");
    expect(() => JSON.parse(yaml)).toThrow();
    expect(JSON.parse(convertSpecFormat(yaml, "json"))).toEqual(JSON.parse(json));
  });

  it("convertSpecFormat 对非法内容原样返回", () => {
    expect(convertSpecFormat("a: [1, 2", "json")).toBe("a: [1, 2");
  });
});

describe("validateSpec OpenAPI 规则", () => {
  it("完整合规定义零 issue", () => {
    expect(validateSpec(PET_SPEC, "openapi-3.0")).toEqual([]);
  });

  it("空内容报 spec-syntax", () => {
    const issues = validateSpec("  ", "openapi-3.0");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule).toBe("spec-syntax");
    expect(issues[0]!.message).toBe("定义内容为空");
  });

  it("语法错误时只返回语法 issue，不继续结构校验", () => {
    const issues = validateSpec("openapi: [unclosed", "openapi-3.0");
    expect(issues.every((i) => i.rule === "spec-syntax")).toBe(true);
  });

  it("缺少 openapi / info 字段报 oas3-schema", () => {
    const issues = validateSpec("paths:\n  /a:\n    get:\n      responses:\n        '200': {description: ok}\n", "openapi-3.0");
    expect(errorsOf(issues)).toContain("oas3-schema");
    expect(issues.some((i) => i.message.includes("openapi"))).toBe(true);
  });

  it("版本与 spec 类型不一致报 spec-type-mismatch", () => {
    const content = PET_SPEC.replace("openapi: 3.0.3", "openapi: 3.1.0");
    expect(errorsOf(validateSpec(content, "openapi-3.0"))).toContain("spec-type-mismatch");
    expect(errorsOf(validateSpec(content, "openapi-3.1"))).not.toContain("spec-type-mismatch");
  });

  it("info 缺 title/version 报错，缺 description/contact 报 warning", () => {
    const content = PET_SPEC.replace(
      /info:\n(?:  .*\n)+/,
      "info:\n  version: 1.0.0\n",
    );
    const issues = validateSpec(content, "openapi-3.0");
    expect(errorsOf(issues).filter((r) => r === "oas3-schema").length).toBeGreaterThanOrEqual(1);
    expect(rulesOf(issues)).toContain("info-description");
    expect(rulesOf(issues)).toContain("info-contact");
  });

  it("缺 servers / tags 为 warning；3.0 缺 paths 为 error", () => {
    const content = `openapi: 3.0.3
info:
  title: X
  version: 1.0.0
  description: d
  contact:
    name: c
`;
    const issues = validateSpec(content, "openapi-3.0");
    expect(rulesOf(issues)).toContain("oas3-api-servers");
    expect(rulesOf(issues)).toContain("openapi-tags");
    expect(errorsOf(issues)).toContain("oas3-schema");
    expect(issues.some((i) => i.message.includes("paths"))).toBe(true);
  });

  it("3.1 允许只有 webhooks 而无 paths", () => {
    const content = `openapi: 3.1.0
info:
  title: X
  version: 1.0.0
  description: d
  contact:
    name: c
servers:
  - url: https://a.b
tags:
  - name: t
    description: d
webhooks:
  newPet:
    post:
      responses:
        "200":
          description: ok
`;
    expect(validateSpec(content, "openapi-3.1")).toEqual([]);
  });

  it("path 键规则：必须 / 开头、禁止 query 串、空占位符、尾斜杠 warning", () => {
    const badPath = (key: string) => `openapi: 3.0.3
info:
  title: X
  version: 1.0.0
  description: d
  contact:
    name: c
servers:
  - url: https://a.b
tags:
  - name: t
    description: d
paths:
  "${key}":
    get:
      operationId: op1
      summary: s
      tags: [t]
      responses:
        "200":
          description: ok
`;
    expect(errorsOf(validateSpec(badPath("pets"), "openapi-3.0"))).toContain("oas3-schema");
    expect(errorsOf(validateSpec(badPath("/pets?id=1"), "openapi-3.0"))).toContain("path-not-include-query");
    expect(errorsOf(validateSpec(badPath("/pets/{}"), "openapi-3.0"))).toContain("path-declarations-must-exist");
    expect(rulesOf(validateSpec(badPath("/pets/"), "openapi-3.0"))).toContain("path-keys-no-trailing-slash");
  });

  it("path-params：占位符未声明参数 / 参数无占位符 / path 参数缺 required 均报错", () => {
    const undeclared = PET_SPEC.replace(/      parameters:\n        - name: petId\n(?:          .*\n)+/, "");
    expect(errorsOf(validateSpec(undeclared, "openapi-3.0"))).toContain("path-params");

    const notRequired = PET_SPEC.replace(
      "        - name: petId\n          in: path\n          required: true",
      "        - name: petId\n          in: path",
    );
    expect(errorsOf(validateSpec(notRequired, "openapi-3.0"))).toContain("path-params");

    const extraParam = PET_SPEC.replace(
      "      parameters:\n        - name: limit",
      "      parameters:\n        - name: ghost\n          in: path\n          required: true\n          schema:\n            type: string\n        - name: limit",
    );
    expect(errorsOf(validateSpec(extraParam, "openapi-3.0"))).toContain("path-params");
  });

  it("操作缺 responses 报错；operationId 缺失为 warning、重复为 error", () => {
    const noResponses = PET_SPEC.replace(/      responses:\n        "201":\n          description: created/, "");
    expect(errorsOf(validateSpec(noResponses, "openapi-3.0"))).toContain("operation-responses");

    const noOpId = PET_SPEC.replace("      operationId: listPets\n", "");
    expect(rulesOf(validateSpec(noOpId, "openapi-3.0"))).toContain("operation-operationId");

    const dup = PET_SPEC.replace("operationId: createPet", "operationId: listPets");
    expect(errorsOf(validateSpec(dup, "openapi-3.0"))).toContain("operation-operationId-unique");
  });

  it("未被引用的组件 schema 报 oas3-unused-component", () => {
    const content = `${PET_SPEC}    Orphan:
      type: object
`;
    const issues = validateSpec(content, "openapi-3.0");
    const orphan = issues.find((i) => i.rule === "oas3-unused-component");
    expect(orphan?.message).toContain("Orphan");
    expect(orphan?.path).toBe("components.schemas.Orphan");
  });

  it("结果排序：错误优先，其次按行号升序", () => {
    const content = `openapi: 3.0.3
paths:
  pets:
    get:
      responses: {}
`;
    const issues = validateSpec(content, "openapi-3.0");
    const ranks = issues.map((i) => (i.severity === "error" ? 0 : 1));
    expect(ranks).toEqual([...ranks].sort());
    const errorLines = issues.filter((i) => i.severity === "error").map((i) => i.line);
    expect(errorLines).toEqual([...errorLines].sort((a, b) => a - b));
  });
});

describe("validateSpec AsyncAPI 规则", () => {
  it("合规模板零 issue；缺 channels 报错", () => {
    const template = createDefaultSpecContent("asyncapi-2.0", "Msg");
    expect(validateSpec(template, "asyncapi-2.0")).toEqual([]);

    const noChannels = template.replace(/channels:[\s\S]*$/, "");
    expect(errorsOf(validateSpec(noChannels, "asyncapi-2.0"))).toContain("asyncapi-schema");
  });

  it("channel 无 publish/subscribe、占位符未声明均报错", () => {
    const base = `asyncapi: 2.0.0
info:
  title: X
  version: 1.0.0
  description: d
  contact:
    name: c
servers:
  prod:
    url: broker:1883
    protocol: mqtt
channels:
`;
    const empty = `${base}  user/signedup:
    description: nothing
`;
    expect(errorsOf(validateSpec(empty, "asyncapi-2.0"))).toContain("asyncapi-channel-operations");

    const paramMissing = `${base}  user/{userId}/signedup:
    subscribe:
      operationId: on
      summary: s
      message:
        payload:
          type: object
`;
    expect(errorsOf(validateSpec(paramMissing, "asyncapi-2.0"))).toContain("asyncapi-channel-parameters");
  });

  it("server 缺 protocol 报错", () => {
    const content = `asyncapi: 2.0.0
info:
  title: X
  version: 1.0.0
  description: d
  contact:
    name: c
servers:
  prod:
    url: broker:1883
channels:
  a/b:
    publish:
      operationId: p
      summary: s
      message:
        payload:
          type: object
`;
    expect(errorsOf(validateSpec(content, "asyncapi-2.0"))).toContain("asyncapi-schema");
  });
});

describe("spec-outline 文档预览模型", () => {
  it("buildSpecOutline 提取标题/服务器/操作/响应示例", () => {
    const outline = buildSpecOutline(PET_SPEC, "openapi-3.0")!;
    expect(outline.title).toBe("Pet API");
    expect(outline.servers[0]!.url).toBe("https://api.example.com/v1");
    expect(outline.tags.map((t) => t.name)).toEqual(["pets"]);
    expect(outline.operations.map((o) => o.key)).toEqual([
      "GET /pets",
      "POST /pets",
      "GET /pets/{petId}",
    ]);

    const list = outline.operations[0]!;
    expect(list.params[0]).toMatchObject({ name: "limit", in: "query", required: false });
    expect(list.responses[0]).toMatchObject({ code: "200", contentType: "application/json" });
    expect(list.responses[0]!.example).toContain('"id"');

    const create = outline.operations[1]!;
    expect(create.requestContentType).toBe("application/json");
    expect(JSON.parse(create.requestExample)).toEqual({ id: "42", name: "tom" });
  });

  it("语法错误时 buildSpecOutline 返回 null；AsyncAPI 走 channels 分支", () => {
    expect(buildSpecOutline("a: [1", "openapi-3.0")).toBeNull();

    const outline = buildSpecOutline(createDefaultSpecContent("asyncapi-2.0", "Msg"), "asyncapi-2.0")!;
    expect(outline.channels).toHaveLength(1);
    expect(outline.channels[0]!.name).toBe("user/signedup");
    expect(outline.channels[0]!.operations[0]!.kind).toBe("subscribe");
    expect(JSON.parse(outline.channels[0]!.operations[0]!.payloadExample)).toHaveProperty("id");
  });

  it("sampleFromSchema：example/default/enum 优先，其次按 type 与 format 取占位值", () => {
    const root = {};
    expect(sampleFromSchema({ example: "x" }, root)).toBe("x");
    expect(sampleFromSchema({ default: 7 }, root)).toBe(7);
    expect(sampleFromSchema({ enum: ["a", "b"] }, root)).toBe("a");
    expect(sampleFromSchema({ type: "integer" }, root)).toBe(0);
    expect(sampleFromSchema({ type: "boolean" }, root)).toBe(true);
    expect(sampleFromSchema({ type: "string", format: "uuid" }, root)).toBe(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(sampleFromSchema({ type: "array", items: { type: "string" } }, root)).toEqual(["string"]);
    expect(
      sampleFromSchema({ type: "object", properties: { a: { type: "number" } } }, root),
    ).toEqual({ a: 0 });
  });

  it("schemaLabel：$ref 取末段、array 包裹、default 附加", () => {
    const root = JSON.parse(convertSpecFormat(PET_SPEC, "json")) as Record<string, unknown>;
    expect(schemaLabel({ $ref: "#/components/schemas/Pet" }, root)).toBe("Pet");
    expect(
      schemaLabel({ type: "array", items: { $ref: "#/components/schemas/Pet" } }, root),
    ).toBe("array<Pet>");
    expect(schemaLabel({ type: "integer", default: 20 }, root)).toBe("integer (default: 20)");
  });
});

describe("specToCollectionDraft（Generate collection）", () => {
  it("按 tag 分文件夹、{id} 转 {{id}}、query 参数进 params、默认 auth 为 none", () => {
    const draft = specToCollectionDraft(PET_SPEC, "openapi-3.0", "fallback");
    expect(draft.name).toBe("Pet API");
    expect(draft.description).toBe("Pet store.");
    expect(draft.folders).toEqual(["pets"]);
    expect(draft.requests.map((r) => `${r.config.method} ${r.config.url}`)).toEqual([
      "GET https://api.example.com/v1/pets",
      "POST https://api.example.com/v1/pets",
      "GET https://api.example.com/v1/pets/{{petId}}",
    ]);
    expect(draft.requests.every((r) => r.folder === "pets")).toBe(true);

    const list = draft.requests[0]!;
    expect(list.config.params[0]).toMatchObject({ key: "limit", enabled: false });
    expect(list.config.auth).toEqual({ type: "none" });

    const create = draft.requests[1]!;
    expect(create.config.body).toMatchObject({ type: "raw", rawLanguage: "json" });
    expect(JSON.parse((create.config.body as { raw: string }).raw)).toEqual({ id: "42", name: "tom" });
  });

  it("无 tag 时回落到 path 首段作为文件夹", () => {
    const content = PET_SPEC.replaceAll(/      tags: \[pets\]\n/g, "");
    const draft = specToCollectionDraft(content, "openapi-3.0", "fallback");
    expect(draft.folders).toEqual(["pets"]);
    expect(draft.requests[0]!.folder).toBe("pets");
  });

  it("security 映射：bearer / apiKey / oauth2，操作级覆盖根级", () => {
    const withSecurity = (scheme: string, security: string) => `openapi: 3.0.3
info:
  title: X
  version: 1.0.0
  description: d
  contact:
    name: c
servers:
  - url: https://a.b
security:
  - main: []
paths:
  /a:
    get:
      operationId: op
      summary: s
      responses:
        "200":
          description: ok
components:
  securitySchemes:
    main:
${scheme}
${security}`;

    const bearer = specToCollectionDraft(
      withSecurity("      type: http\n      scheme: bearer", ""),
      "openapi-3.0",
      "f",
    );
    expect(bearer.requests[0]!.config.auth.type).toBe("bearer");

    const apiKey = specToCollectionDraft(
      withSecurity("      type: apiKey\n      in: header\n      name: X-Api-Key", ""),
      "openapi-3.0",
      "f",
    );
    expect(apiKey.requests[0]!.config.auth).toEqual({
      type: "api-key",
      apiKey: { key: "X-Api-Key", in: "header" },
    });

    const oauth = specToCollectionDraft(
      withSecurity(
        "      type: oauth2\n      flows:\n        clientCredentials:\n          tokenUrl: https://a.b/token",
        "",
      ),
      "openapi-3.0",
      "f",
    );
    expect(oauth.requests[0]!.config.auth.type).toBe("oauth2");

    // 操作级 security: [] 覆盖根级 → none
    const overridden = specToCollectionDraft(
      withSecurity("      type: http\n      scheme: bearer", "").replace(
        "      operationId: op",
        "      security: []\n      operationId: op",
      ),
      "openapi-3.0",
      "f",
    );
    expect(overridden.requests[0]!.config.auth.type).toBe("none");
  });

  it("urlencoded requestBody 生成表单行并按 required 勾选", () => {
    const content = `openapi: 3.0.3
info:
  title: X
  version: 1.0.0
  description: d
  contact:
    name: c
servers:
  - url: https://a.b
paths:
  /login:
    post:
      operationId: login
      summary: Login
      requestBody:
        content:
          application/x-www-form-urlencoded:
            schema:
              type: object
              required: [username]
              properties:
                username:
                  type: string
                memo:
                  type: string
      responses:
        "200":
          description: ok
`;
    const draft = specToCollectionDraft(content, "openapi-3.0", "f");
    const body = draft.requests[0]!.config.body as {
      type: string;
      urlencoded: { key: string; enabled: boolean }[];
    };
    expect(body.type).toBe("x-www-form-urlencoded");
    expect(body.urlencoded.map(({ key, enabled }) => ({ key, enabled }))).toEqual([
      { key: "username", enabled: true },
      { key: "memo", enabled: false },
    ]);
  });

  it("AsyncAPI 与无法解析的内容返回空草稿", () => {
    const asyncDraft = specToCollectionDraft(
      createDefaultSpecContent("asyncapi-2.0", "Msg"),
      "asyncapi-2.0",
      "fallback",
    );
    expect(asyncDraft).toEqual({ name: "fallback", description: "", folders: [], requests: [] });
    expect(specToCollectionDraft("a: [1", "openapi-3.0", "fallback").requests).toEqual([]);
  });
});
