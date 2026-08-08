import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pmToNodes } from "../src/components/sidebar/ImportCollectionModal";

/** 读取 mock-server 的多协议 Postman collection，验证导入转换（vitest 以 apps/web 为 cwd） */
const collection = JSON.parse(
  readFileSync(
    "../mock-server/postman/multiprotocol.postman_collection.json",
    "utf8",
  ),
) as { item: never[] };

const nodes = pmToNodes(collection.item);

describe("Postman collection 导入转换", () => {
  it("顶层 folder 结构完整", () => {
    expect(nodes.map((n) => n.name)).toEqual([
      "Health",
      "HTTP 冒烟",
      "GraphQL",
      "SSE",
    ]);
  });

  it("graphql body 的请求转为 GraphQL 协议（POST + query/variables）", () => {
    const gqlFolder = nodes.find((n) => n.name === "GraphQL");
    expect(gqlFolder?.type).toBe("folder");
    const items = gqlFolder?.type === "folder" ? gqlFolder.items : [];
    expect(items?.length).toBe(4);
    for (const item of items ?? []) {
      if (item.type !== "request") throw new Error("应为 request 节点");
      const cfg = item.request!;
      expect(cfg.protocol).toBe("graphql");
      expect(cfg.method).toBe("POST");
      expect(cfg.body.type).toBe("graphql");
      expect(cfg.body.graphqlQuery).toBeTruthy();
      expect(cfg.url).toBe("{{baseUrl}}/graphql");
    }
  });

  it("带变量的 query 保留 variables 文本", () => {
    const gqlFolder = nodes.find((n) => n.name === "GraphQL");
    const hello =
      gqlFolder?.type === "folder"
        ? gqlFolder.items?.find((i) => i.name.includes("Hello"))
        : undefined;
    if (hello?.type !== "request") throw new Error("缺少 Hello 请求");
    expect(hello.request!.body.graphqlVariables).toContain("Postman");
  });

  it("HTTP/SSE 请求保持 http 协议且 URL/断言脚本转换正确（pm→rp）", () => {
    const httpFolder = nodes.find((n) => n.name === "HTTP 冒烟");
    const first =
      httpFolder?.type === "folder" ? httpFolder.items?.[0] : undefined;
    if (first?.type !== "request") throw new Error("缺少 HTTP 请求");
    expect(first.request!.protocol ?? "http").toBe("http");
    expect(first.request!.params.some((p) => p.key === "foo" && p.value === "bar")).toBe(true);
    // 断言脚本 pm.* 改名 rp.*
    expect(first.request!.scripts.test).toContain("rp.test(");
    expect(first.request!.scripts.test).not.toContain("pm.test(");

    const sseFolder = nodes.find((n) => n.name === "SSE");
    const sse = sseFolder?.type === "folder" ? sseFolder.items?.[0] : undefined;
    if (sse?.type !== "request") throw new Error("缺少 SSE 请求");
    expect(sse.request!.url).toBe("{{baseUrl}}/sse/finite");
  });
});
