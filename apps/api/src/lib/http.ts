import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { ApiErr, ApiOk, TeamRole, User } from "@rabbitpost/shared";
import { db } from "../db";
import {
  collectionItems,
  collections,
  documentItems,
  environments,
  specs,
  teamMembers,
  workspaces,
} from "../db/schema";
import { getSessionUser } from "./auth";

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export function ok<T>(data: T, init?: ResponseInit): NextResponse<ApiOk<T>> {
  return NextResponse.json({ ok: true, data }, init);
}

export function err(
  status: number,
  code: string,
  message: string,
  extra?: Partial<ApiErr["error"]>,
): NextResponse<ApiErr> {
  return NextResponse.json(
    { ok: false, error: { code, message, ...extra } },
    { status },
  );
}

/** 业务异常：携带 HTTP 状态码，路由层 throw 后由 handleRoute 统一转成响应 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 包裹 route handler：统一鉴权失败/业务异常/未知异常的响应格式；未知错误原文透传 */
export function handleRoute<Ctx>(
  handler: (req: Request, ctx: Ctx, user: User) => Promise<Response>,
): (req: Request, ctx: Ctx) => Promise<Response> {
  return async (req, ctx) => {
    try {
      const user = await getSessionUser();
      if (!user) return err(401, "UNAUTHORIZED", "Not signed in");
      return await handler(req, ctx, user);
    } catch (e) {
      if (e instanceof HttpError) {
        return err(e.status, e.code, e.message);
      }
      // 未知错误原文透传，不做笼统封装
      const message = e instanceof Error ? e.message : String(e);
      console.error("[api] unhandled error:", e);
      return err(500, "INTERNAL_ERROR", message);
    }
  };
}

// ---------------------------------------------------------------------------
// Access control helpers
// ---------------------------------------------------------------------------

const ROLE_ORDER: Record<TeamRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

/** 校验用户是团队成员，且角色不低于 minRole；返回实际角色 */
export async function requireTeamRole(
  teamId: string,
  userId: string,
  minRole: TeamRole = "viewer",
): Promise<TeamRole> {
  const [member] = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  if (!member) throw new HttpError(403, "FORBIDDEN", "Not a member of this team");
  if (ROLE_ORDER[member.role] < ROLE_ORDER[minRole]) {
    throw new HttpError(403, "FORBIDDEN", `Requires team role >= ${minRole}`);
  }
  return member.role;
}

/** 通过 workspaceId 找到所属团队并校验成员权限 */
export async function requireWorkspaceRole(
  workspaceId: string,
  userId: string,
  minRole: TeamRole = "viewer",
): Promise<{ teamId: string; role: TeamRole }> {
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!ws) throw new HttpError(404, "NOT_FOUND", "Workspace not found");
  const role = await requireTeamRole(ws.teamId, userId, minRole);
  return { teamId: ws.teamId, role };
}

/** 通过 collectionId 级联校验 workspace 权限 */
export async function requireCollectionRole(
  collectionId: string,
  userId: string,
  minRole: TeamRole = "viewer",
): Promise<{ workspaceId: string; role: TeamRole }> {
  const [col] = await db
    .select()
    .from(collections)
    .where(eq(collections.id, collectionId))
    .limit(1);
  if (!col) throw new HttpError(404, "NOT_FOUND", "Collection not found");
  const { role } = await requireWorkspaceRole(col.workspaceId, userId, minRole);
  return { workspaceId: col.workspaceId, role };
}

/** 通过 collectionItemId 级联校验权限 */
export async function requireItemRole(
  itemId: string,
  userId: string,
  minRole: TeamRole = "viewer",
): Promise<{ collectionId: string; workspaceId: string; role: TeamRole }> {
  const [item] = await db
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.id, itemId))
    .limit(1);
  if (!item) throw new HttpError(404, "NOT_FOUND", "Collection item not found");
  const { workspaceId, role } = await requireCollectionRole(
    item.collectionId,
    userId,
    minRole,
  );
  return { collectionId: item.collectionId, workspaceId, role };
}

/** 通过 documentItemId 级联校验权限 */
export async function requireDocumentRole(
  documentId: string,
  userId: string,
  minRole: TeamRole = "viewer",
): Promise<{ workspaceId: string; role: TeamRole }> {
  const [item] = await db
    .select()
    .from(documentItems)
    .where(eq(documentItems.id, documentId))
    .limit(1);
  if (!item) throw new HttpError(404, "NOT_FOUND", "Document item not found");
  const { role } = await requireWorkspaceRole(item.workspaceId, userId, minRole);
  return { workspaceId: item.workspaceId, role };
}

/** 通过 specId 级联校验权限 */
export async function requireSpecRole(
  specId: string,
  userId: string,
  minRole: TeamRole = "viewer",
): Promise<{ workspaceId: string; role: TeamRole }> {
  const [row] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Spec not found");
  const { role } = await requireWorkspaceRole(row.workspaceId, userId, minRole);
  return { workspaceId: row.workspaceId, role };
}

/** 通过 environmentId 级联校验权限 */
export async function requireEnvironmentRole(
  environmentId: string,
  userId: string,
  minRole: TeamRole = "viewer",
): Promise<{ workspaceId: string; role: TeamRole }> {
  const [row] = await db
    .select()
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Environment not found");
  const { role } = await requireWorkspaceRole(row.workspaceId, userId, minRole);
  return { workspaceId: row.workspaceId, role };
}
