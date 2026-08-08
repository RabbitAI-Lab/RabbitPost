import { describe, expect, it } from "vitest";
import { requestSchema } from "../src/app/api/v1/execute/route";

/** execute 路由请求配置的容错：body 缺失 / body.type 缺失或非法时按 none 处理 */

const baseRequest = {
  method: "GET",
  url: "https://example.com",
  auth: { type: "none" },
  scripts: {},
};

describe("execute requestSchema body 容错", () => {
  it("body 字段整体缺失 → 默认 none", () => {
    const parsed = requestSchema.parse({ ...baseRequest });
    expect(parsed.body.type).toBe("none");
  });

  it("body.type 缺失 → 默认 none", () => {
    const parsed = requestSchema.parse({ ...baseRequest, body: {} });
    expect(parsed.body.type).toBe("none");
  });

  it("body.type 非法值 → 容错为 none（不中断执行）", () => {
    const parsed = requestSchema.parse({
      ...baseRequest,
      body: { type: "not-a-real-type" },
    });
    expect(parsed.body.type).toBe("none");
  });

  it("合法 body 原样通过（raw + 自定义字段 passthrough）", () => {
    const parsed = requestSchema.parse({
      ...baseRequest,
      body: { type: "raw", raw: "{}", rawLanguage: "json", graphqlQuery: "q" },
    });
    expect(parsed.body.type).toBe("raw");
    expect((parsed.body as Record<string, unknown>).graphqlQuery).toBe("q");
  });
});
