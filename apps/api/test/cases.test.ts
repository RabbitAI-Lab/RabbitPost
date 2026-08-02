/**
 * 接口用例 CRUD / reset / 权限 / collection 批量端点的路由级回归测试。
 * route handler 直接以构造的 Request 调用，鉴权走真实 API Key（sha256）链路。
 */
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

// 直接调用 route handler 时没有 Next 请求上下文，getSessionUser 的 cookies() 会抛错；
// 固定为 null（未登录），API Key 链路保留真实实现
vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionUser: async () => null,
}));
import type { RequestCase } from "@rabbitpost/shared";
import { db } from "../src/db";
import { collectionItems } from "../src/db/schema";
import {
  GET as listCases,
  POST as createCase,
} from "../src/app/api/v1/items/[itemId]/cases/route";
import {
  DELETE as deleteCase,
  GET as getCase,
  PATCH as patchCase,
} from "../src/app/api/v1/cases/[caseId]/route";
import { POST as resetCase } from "../src/app/api/v1/cases/[caseId]/reset/route";
import { GET as collectionCases } from "../src/app/api/v1/collections/[collectionId]/cases/route";
import { authed, envelope, seedBasic, seedOutsiderToken } from "./helpers";

const itemCtx = (itemId: string) => ({ params: Promise.resolve({ itemId }) });
const caseCtx = (caseId: string) => ({ params: Promise.resolve({ caseId }) });
const colCtx = (collectionId: string) => ({ params: Promise.resolve({ collectionId }) });

const itemCasesPath = (itemId: string) => `/api/v1/items/${itemId}/cases`;
const casePath = (caseId: string) => `/api/v1/cases/${caseId}`;

describe("request cases CRUD", () => {
  it("新建用例继承接口当前配置（快照），缺省名称按数量递增", async () => {
    const s = await seedBasic();

    const r1 = await envelope<RequestCase>(
      await createCase(authed(itemCasesPath(s.itemId), s.apiToken, { method: "POST" }), itemCtx(s.itemId)),
    );
    expect(r1.status).toBe(201);
    expect(r1.data.name).toBe("Case 1");
    // 快照继承：method/url 与接口一致
    expect(r1.data.request.method).toBe("GET");
    expect(r1.data.request.url).toBe("{{baseUrl}}/health");
    expect(r1.data.itemId).toBe(s.itemId);
    expect(r1.data.sortOrder).toBe(0);

    const r2 = await envelope<RequestCase>(
      await createCase(authed(itemCasesPath(s.itemId), s.apiToken, { method: "POST" }), itemCtx(s.itemId)),
    );
    expect(r2.data.name).toBe("Case 2");
    expect(r2.data.sortOrder).toBe(1);

    // 快照独立性：接口配置后续改动不影响已建用例
    await db
      .update(collectionItems)
      .set({ request: { ...r1.data.request, url: "{{baseUrl}}/changed" } })
      .where(eq(collectionItems.id, s.itemId));
    const after = await envelope<RequestCase>(
      await getCase(authed(casePath(r1.data.id), s.apiToken), caseCtx(r1.data.id)),
    );
    expect(after.data.request.url).toBe("{{baseUrl}}/health");
  });

  it("支持指定名称/说明/配置创建（复制用例路径）", async () => {
    const s = await seedBasic();
    const first = (
      await envelope<RequestCase>(
        await createCase(authed(itemCasesPath(s.itemId), s.apiToken, { method: "POST" }), itemCtx(s.itemId)),
      )
    ).data;

    const dup = await envelope<RequestCase>(
      await createCase(
        authed(itemCasesPath(s.itemId), s.apiToken, {
          method: "POST",
          json: { name: `${first.name} Copy`, description: "副本", request: first.request },
        }),
        itemCtx(s.itemId),
      ),
    );
    expect(dup.status).toBe(201);
    expect(dup.data.name).toBe("Case 1 Copy");
    expect(dup.data.description).toBe("副本");
  });

  it("列表按 sortOrder 排序返回", async () => {
    const s = await seedBasic();
    for (const name of ["B case", "A case", "C case"]) {
      await createCase(
        authed(itemCasesPath(s.itemId), s.apiToken, { method: "POST", json: { name } }),
        itemCtx(s.itemId),
      );
    }
    const list = await envelope<RequestCase[]>(
      await listCases(authed(itemCasesPath(s.itemId), s.apiToken), itemCtx(s.itemId)),
    );
    expect(list.data.map((c) => c.name)).toEqual(["B case", "A case", "C case"]);
  });

  it("PATCH 更新名称与配置；DELETE 后 GET 返回 404", async () => {
    const s = await seedBasic();
    const created = (
      await envelope<RequestCase>(
        await createCase(authed(itemCasesPath(s.itemId), s.apiToken, { method: "POST" }), itemCtx(s.itemId)),
      )
    ).data;

    const patched = await envelope<RequestCase>(
      await patchCase(
        authed(casePath(created.id), s.apiToken, {
          method: "PATCH",
          json: {
            name: "Renamed",
            request: { ...created.request, method: "POST", url: "{{baseUrl}}/modified" },
          },
        }),
        caseCtx(created.id),
      ),
    );
    expect(patched.data.name).toBe("Renamed");
    expect(patched.data.request.method).toBe("POST");
    expect(patched.data.request.url).toBe("{{baseUrl}}/modified");

    const del = await envelope(
      await deleteCase(authed(casePath(created.id), s.apiToken, { method: "DELETE" }), caseCtx(created.id)),
    );
    expect(del.status).toBe(200);
    const gone = await envelope(
      await getCase(authed(casePath(created.id), s.apiToken), caseCtx(created.id)),
    );
    expect(gone.status).toBe(404);
    expect(gone.error?.code).toBe("NOT_FOUND");
  });

  it("reset 从接口当前配置重新继承（覆盖用例修改）", async () => {
    const s = await seedBasic();
    const created = (
      await envelope<RequestCase>(
        await createCase(authed(itemCasesPath(s.itemId), s.apiToken, { method: "POST" }), itemCtx(s.itemId)),
      )
    ).data;
    // 用例改坏 + 接口演进
    await patchCase(
      authed(casePath(created.id), s.apiToken, {
        method: "PATCH",
        json: { request: { ...created.request, method: "DELETE", url: "{{baseUrl}}/broken" } },
      }),
      caseCtx(created.id),
    );
    const [item] = await db.select().from(collectionItems).where(eq(collectionItems.id, s.itemId));
    await db
      .update(collectionItems)
      .set({ request: { ...item!.request!, url: "{{baseUrl}}/v2/health", method: "POST" } })
      .where(eq(collectionItems.id, s.itemId));

    const reset = await envelope<RequestCase>(
      await resetCase(authed(`${casePath(created.id)}/reset`, s.apiToken, { method: "POST" }), caseCtx(created.id)),
    );
    expect(reset.status).toBe(200);
    expect(reset.data.request.method).toBe("POST");
    expect(reset.data.request.url).toBe("{{baseUrl}}/v2/health");
  });

  it("folder 条目不能挂用例", async () => {
    const s = await seedBasic();
    const [folder] = await db
      .insert(collectionItems)
      .values({ collectionId: s.collectionId, type: "folder", name: "Folder" })
      .returning();
    const resp = await envelope(
      await createCase(authed(itemCasesPath(folder.id), s.apiToken, { method: "POST" }), itemCtx(folder.id)),
    );
    expect(resp.status).toBe(400);
    expect(resp.error?.code).toBe("INVALID_ITEM_TYPE");
  });

  it("未认证 401；非团队成员 403", async () => {
    const s = await seedBasic();
    const anon = await envelope(await listCases(authed(itemCasesPath(s.itemId), null), itemCtx(s.itemId)));
    expect(anon.status).toBe(401);

    const outsider = await seedOutsiderToken();
    const forbidden = await envelope(
      await listCases(authed(itemCasesPath(s.itemId), outsider), itemCtx(s.itemId)),
    );
    expect(forbidden.status).toBe(403);
  });
});

describe("collection 级批量端点", () => {
  it("GET /api/v1/collections/:id/cases 返回该 Collection 全部用例（扁平、含 itemId）", async () => {
    const s = await seedBasic();
    const [item2] = await db
      .insert(collectionItems)
      .values({
        collectionId: s.collectionId,
        type: "request",
        name: "Second",
        request: { ...((await db.select().from(collectionItems).where(eq(collectionItems.id, s.itemId)))[0]!.request!) },
      })
      .returning();
    for (const [itemId, name] of [
      [s.itemId, "case-a"],
      [s.itemId, "case-b"],
      [item2.id, "case-c"],
    ] as const) {
      await createCase(
        authed(itemCasesPath(itemId), s.apiToken, { method: "POST", json: { name } }),
        itemCtx(itemId),
      );
    }

    const resp = await envelope<RequestCase[]>(
      await collectionCases(
        authed(`/api/v1/collections/${s.collectionId}/cases`, s.apiToken),
        colCtx(s.collectionId),
      ),
    );
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveLength(3);
    // sortOrder 是 per-item 的：全局只做集合断言，同一 item 内保持 sortOrder 先后
    expect(resp.data.map((c) => c.name).sort()).toEqual(["case-a", "case-b", "case-c"]);
    const names = resp.data.map((c) => c.name);
    expect(names.indexOf("case-a")).toBeLessThan(names.indexOf("case-b"));
    expect(resp.data.find((c) => c.name === "case-c")!.itemId).toBe(item2.id);
  });
});
