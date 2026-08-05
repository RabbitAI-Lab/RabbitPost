/**
 * Specs 模块路由级回归测试：CRUD / 权限 / Generate collection（含覆盖同步）。
 * route handler 直接以构造的 Request 调用，鉴权走真实 API Key（sha256）链路。
 */
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

// 直接调用 route handler 时没有 Next 请求上下文，getSessionUser 的 cookies() 会抛错；
// 固定为 null（未登录），API Key 链路保留真实实现
vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionUser: async () => null,
}));
import type { Spec } from "@rabbitpost/shared";
import { db } from "../src/db";
import { apiKeys, collectionItems, collections, specs, teamMembers, users } from "../src/db/schema";
import {
  GET as listSpecs,
  POST as createSpec,
} from "../src/app/api/v1/workspaces/[workspaceId]/specs/route";
import {
  DELETE as deleteSpec,
  GET as getSpec,
  PATCH as patchSpec,
} from "../src/app/api/v1/specs/[specId]/route";
import { POST as generateCollection } from "../src/app/api/v1/specs/[specId]/generate-collection/route";
import { authed, envelope, seedBasic, seedOutsiderToken, type Seed } from "./helpers";

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const wsCtx = (workspaceId: string) => ({ params: Promise.resolve({ workspaceId }) });
const specCtx = (specId: string) => ({ params: Promise.resolve({ specId }) });
const wsPath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/specs`;
const specPath = (specId: string) => `/api/v1/specs/${specId}`;
const genPath = (specId: string) => `/api/v1/specs/${specId}/generate-collection`;

/** 一份可零 issue 通过校验并含 3 个端点的 OpenAPI 3.0 定义 */
const VALID_SPEC = `openapi: 3.0.3
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
      responses:
        "200":
          description: ok
    post:
      tags: [pets]
      operationId: createPet
      summary: Create pet
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
`;

/** 缺 responses 的定义：校验出 error，generate 应被拦截 */
const BROKEN_SPEC = `openapi: 3.0.3
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
  /a:
    get:
      operationId: op
      summary: s
      tags: [t]
`;

/** 只有 webhooks 的 3.1 定义：校验通过但没有可生成的 HTTP 端点 */
const WEBHOOKS_ONLY_SPEC = `openapi: 3.1.0
info:
  title: Hooks
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

async function create(
  s: Seed,
  body: { name: string; type?: string; format?: string; content?: string },
) {
  return envelope<Spec>(
    await createSpec(
      authed(wsPath(s.workspaceId), s.apiToken, {
        method: "POST",
        json: { type: "openapi-3.0", ...body },
      }),
      wsCtx(s.workspaceId),
    ),
  );
}

/** 在 seedBasic 的团队里追加一个 viewer 成员，返回其 API Key */
async function seedViewerToken(s: Seed): Promise<string> {
  const suffix = crypto.randomBytes(4).toString("hex");
  const [user] = await db
    .insert(users)
    .values({ casdoorId: `viewer-${suffix}`, name: "Viewer" })
    .returning();
  await db.insert(teamMembers).values({ teamId: s.teamId, userId: user.id, role: "viewer" });
  const token = `rpk_view_${crypto.randomBytes(16).toString("hex")}`;
  await db.insert(apiKeys).values({
    userId: user.id,
    name: "viewer-key",
    keyHash: sha256(token),
    keyPrefix: token.slice(0, 12),
  });
  return token;
}

describe("specs CRUD", () => {
  it("新建时缺省内容按类型填充起始模板，且模板零 issue 可生成", async () => {
    const s = await seedBasic();
    const r = await create(s, { name: "My Spec" });
    expect(r.status).toBe(201);
    expect(r.data.name).toBe("My Spec");
    expect(r.data.type).toBe("openapi-3.0");
    expect(r.data.format).toBe("yaml");
    expect(r.data.content).toContain("openapi: 3.0.3");
    expect(r.data.generatedCollectionId).toBeNull();
  });

  it("支持 json 格式与自定义内容；空内容回落模板", async () => {
    const s = await seedBasic();
    const jsonSpec = await create(s, { name: "J", format: "json" });
    expect(JSON.parse(jsonSpec.data.content).info.title).toBe("J");

    const custom = await create(s, {
      name: "C",
      type: "openapi-3.1",
      content: VALID_SPEC.replace("3.0.3", "3.1.0"),
    });
    expect(custom.data.content).toBe(VALID_SPEC.replace("3.0.3", "3.1.0"));

    const blank = await create(s, { name: "B", content: "   " });
    expect(blank.data.content).toContain("openapi: 3.0.3");
  });

  it("列表 / 单查 / 404 / PATCH / DELETE", async () => {
    const s = await seedBasic();
    const created = (await create(s, { name: "A" })).data;

    const list = await envelope<Spec[]>(
      await listSpecs(authed(wsPath(s.workspaceId), s.apiToken), wsCtx(s.workspaceId)),
    );
    expect(list.data.map((x) => x.id)).toContain(created.id);

    const one = await envelope<Spec>(
      await getSpec(authed(specPath(created.id), s.apiToken), specCtx(created.id)),
    );
    expect(one.data.name).toBe("A");

    const ghostId = crypto.randomUUID();
    const missing = await envelope(
      await getSpec(authed(specPath(ghostId), s.apiToken), specCtx(ghostId)),
    );
    expect(missing.status).toBe(404);

    const patched = await envelope<Spec>(
      await patchSpec(
        authed(specPath(created.id), s.apiToken, {
          method: "PATCH",
          json: { name: "A2", content: VALID_SPEC },
        }),
        specCtx(created.id),
      ),
    );
    expect(patched.data.name).toBe("A2");
    expect(patched.data.content).toBe(VALID_SPEC);

    const del = await envelope(
      await deleteSpec(authed(specPath(created.id), s.apiToken, { method: "DELETE" }), specCtx(created.id)),
    );
    expect(del.ok).toBe(true);
    expect((await envelope(await getSpec(authed(specPath(created.id), s.apiToken), specCtx(created.id)))).status).toBe(404);
  });
});

describe("specs 权限", () => {
  it("团队外用户：workspace 级与 spec 级均 403", async () => {
    const s = await seedBasic();
    const created = (await create(s, { name: "A" })).data;
    const outsider = await seedOutsiderToken();

    expect(
      (await envelope(await listSpecs(authed(wsPath(s.workspaceId), outsider), wsCtx(s.workspaceId)))).status,
    ).toBe(403);
    expect(
      (await envelope(await createSpec(authed(wsPath(s.workspaceId), outsider, { method: "POST", json: { name: "X", type: "openapi-3.0" } }), wsCtx(s.workspaceId)))).status,
    ).toBe(403);
    // requireSpecRole 先查 spec 行再校验成员：spec 存在时外部用户得到 403
    expect(
      (await envelope(await getSpec(authed(specPath(created.id), outsider), specCtx(created.id)))).status,
    ).toBe(403);
  });

  it("viewer 可读不可写：list/get 200，create/patch/generate 403", async () => {
    const s = await seedBasic();
    const created = (await create(s, { name: "A" })).data;
    const viewer = await seedViewerToken(s);

    expect(
      (await envelope(await listSpecs(authed(wsPath(s.workspaceId), viewer), wsCtx(s.workspaceId)))).status,
    ).toBe(200);
    expect(
      (await envelope(await getSpec(authed(specPath(created.id), viewer), specCtx(created.id)))).status,
    ).toBe(200);
    expect(
      (await envelope(await createSpec(authed(wsPath(s.workspaceId), viewer, { method: "POST", json: { name: "X", type: "openapi-3.0" } }), wsCtx(s.workspaceId)))).status,
    ).toBe(403);
    expect(
      (await envelope(await patchSpec(authed(specPath(created.id), viewer, { method: "PATCH", json: { name: "X" } }), specCtx(created.id)))).status,
    ).toBe(403);
    expect(
      (await envelope(await generateCollection(authed(genPath(created.id), viewer, { method: "POST", json: {} }), specCtx(created.id)))).status,
    ).toBe(403);
  });
});

describe("generate-collection", () => {
  it("由定义生成 Collection：文件夹按 tag、占位符转 {{}}、回写关联 id", async () => {
    const s = await seedBasic();
    const spec = (await create(s, { name: "Pet", content: VALID_SPEC })).data;

    const r = await envelope<{
      collectionId: string;
      reused: boolean;
      folderCount: number;
      requestCount: number;
    }>(
      await generateCollection(authed(genPath(spec.id), s.apiToken, { method: "POST", json: {} }), specCtx(spec.id)),
    );
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ reused: false, folderCount: 1, requestCount: 3 });

    const [col] = await db.select().from(collections).where(eq(collections.id, r.data.collectionId));
    expect(col?.name).toBe("Pet API");
    expect(col?.description).toBe("Pet store.");

    const items = await db
      .select()
      .from(collectionItems)
      .where(eq(collectionItems.collectionId, r.data.collectionId));
    const folder = items.find((i) => i.type === "folder");
    const requests = items.filter((i) => i.type === "request");
    expect(folder?.name).toBe("pets");
    expect(requests).toHaveLength(3);
    expect(requests.every((i) => i.parentId === folder?.id)).toBe(true);
    const getPet = requests.find((i) => i.name === "Get a pet");
    expect(getPet?.request?.url).toBe("https://api.example.com/v1/pets/{{petId}}");

    // spec 回写关联 Collection
    const [after] = await db.select().from(specs).where(eq(specs.id, spec.id));
    expect(after?.generatedCollectionId).toBe(r.data.collectionId);
  });

  it("replaceLinked 复用并覆盖已关联 Collection，不产生重复条目", async () => {
    const s = await seedBasic();
    const spec = (await create(s, { name: "Pet", content: VALID_SPEC })).data;
    const first = await envelope<{ collectionId: string; requestCount: number }>(
      await generateCollection(authed(genPath(spec.id), s.apiToken, { method: "POST", json: {} }), specCtx(spec.id)),
    );

    // 定义更新后整体覆盖同步（Postman 的 sync 行为）
    await patchSpec(
      authed(specPath(spec.id), s.apiToken, {
        method: "PATCH",
        json: { content: `${VALID_SPEC}  /extra:\n    get:\n      tags: [pets]\n      operationId: extra\n      summary: Extra\n      responses:\n        "200":\n          description: ok\n` },
      }),
      specCtx(spec.id),
    );
    const second = await envelope<{ collectionId: string; reused: boolean; requestCount: number }>(
      await generateCollection(
        authed(genPath(spec.id), s.apiToken, { method: "POST", json: { replaceLinked: true } }),
        specCtx(spec.id),
      ),
    );
    expect(second.data.collectionId).toBe(first.data.collectionId);
    expect(second.data.reused).toBe(true);
    expect(second.data.requestCount).toBe(4);

    const items = await db
      .select()
      .from(collectionItems)
      .where(eq(collectionItems.collectionId, first.data.collectionId));
    expect(items.filter((i) => i.type === "request")).toHaveLength(4);
  });

  it("AsyncAPI / 校验有错 / 无端点的定义分别被拦截", async () => {
    const s = await seedBasic();

    const asyncSpec = (await create(s, { name: "Msg", type: "asyncapi-2.0" })).data;
    const rAsync = await envelope(
      await generateCollection(authed(genPath(asyncSpec.id), s.apiToken, { method: "POST", json: {} }), specCtx(asyncSpec.id)),
    );
    expect(rAsync.status).toBe(400);
    expect(rAsync.error?.code).toBe("UNSUPPORTED_SPEC_TYPE");

    const broken = (await create(s, { name: "Broken", content: BROKEN_SPEC })).data;
    const rBroken = await envelope(
      await generateCollection(authed(genPath(broken.id), s.apiToken, { method: "POST", json: {} }), specCtx(broken.id)),
    );
    expect(rBroken.status).toBe(400);
    expect(rBroken.error?.code).toBe("SPEC_HAS_ERRORS");

    const hooks = (await create(s, { name: "Hooks", type: "openapi-3.1", content: WEBHOOKS_ONLY_SPEC })).data;
    const rEmpty = await envelope(
      await generateCollection(authed(genPath(hooks.id), s.apiToken, { method: "POST", json: {} }), specCtx(hooks.id)),
    );
    expect(rEmpty.status).toBe(400);
    expect(rEmpty.error?.code).toBe("EMPTY_SPEC");
  });

  it("关联 Collection 被删除后 generatedCollectionId 回落为 null", async () => {
    const s = await seedBasic();
    const spec = (await create(s, { name: "Pet", content: VALID_SPEC })).data;
    const gen = await envelope<{ collectionId: string }>(
      await generateCollection(authed(genPath(spec.id), s.apiToken, { method: "POST", json: {} }), specCtx(spec.id)),
    );

    await db.delete(collectionItems).where(eq(collectionItems.collectionId, gen.data.collectionId));
    await db.delete(collections).where(
      and(eq(collections.id, gen.data.collectionId), eq(collections.workspaceId, s.workspaceId)),
    );

    const one = await envelope<Spec>(
      await getSpec(authed(specPath(spec.id), s.apiToken), specCtx(spec.id)),
    );
    expect(one.data.generatedCollectionId).toBeNull();
  });
});
