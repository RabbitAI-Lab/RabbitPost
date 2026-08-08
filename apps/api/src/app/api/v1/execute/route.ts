import { z } from "zod";
import {
  BODY_TYPES,
  HTTP_METHODS,
  HTTP_VERSIONS,
  RAW_LANGUAGES,
  AUTH_TYPES,
  TLS_PROTOCOLS,
  type ExecuteRequestInput,
} from "@rabbitpost/shared";
import { db } from "../../../../db";
import { histories } from "../../../../db/schema";
import { executeRequest } from "../../../../lib/executor";
import { handleRoute, HttpError, ok, requireWorkspaceRole } from "../../../../lib/http";
import { dispatchAndWait } from "../../../../lib/runner-dispatch";
import { hasAvailableRunner } from "../../../../lib/embedded-runner";

const kvSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    value: z.string(),
    enabled: z.boolean(),
    description: z.string().optional(),
  })
  .passthrough();

const settingsSchema = z.object({
  httpVersion: z.enum(HTTP_VERSIONS).optional(),
  verifySsl: z.boolean().optional(),
  followRedirects: z.boolean().optional(),
  followOriginalHttpMethod: z.boolean().optional(),
  followAuthorizationHeader: z.boolean().optional(),
  removeRefererOnRedirect: z.boolean().optional(),
  strictHttpParser: z.boolean().optional(),
  encodeUrl: z.boolean().optional(),
  disableCookieJar: z.boolean().optional(),
  useServerCipherSuite: z.boolean().optional(),
  maxRedirects: z.number().int().min(0).max(100).optional(),
  disabledTlsProtocols: z.array(z.enum(TLS_PROTOCOLS)).optional(),
  cipherSuites: z.string().optional(),
  timeoutMs: z.number().int().min(0).optional(),
});

// 各 auth 类型与 body 的字段结构随类型而异，统一 passthrough，避免静默丢弃配置
const requestSchema = z
  .object({
    method: z.enum(HTTP_METHODS),
    url: z.string().min(1),
    params: z.array(kvSchema).default([]),
    headers: z.array(kvSchema).default([]),
    body: z
      .object({
        type: z.enum(BODY_TYPES),
        raw: z.string().optional(),
        rawLanguage: z.enum(RAW_LANGUAGES).optional(),
        formData: z.array(kvSchema).optional(),
        urlencoded: z.array(kvSchema).optional(),
        binaryBase64: z.string().optional(),
        binaryFileName: z.string().optional(),
      })
      .passthrough(),
    auth: z
      .object({
        type: z.enum(AUTH_TYPES),
      })
      .passthrough(),
    scripts: z.object({
      preRequest: z.string().optional(),
      test: z.string().optional(),
    }),
    settings: settingsSchema.optional(),
  })
  .passthrough();

const inputSchema = z.object({
  workspaceId: z.string().uuid(),
  environmentId: z.string().uuid().nullable().optional(),
  name: z.string().max(256).optional(),
  request: requestSchema,
  /** 可选：Collection Item ID，用于 Runner 模式关联已保存的请求 */
  itemId: z.string().uuid().optional(),
});

/**
 * POST /api/v1/execute
 * 执行 HTTP 请求：优先通过 Runner 执行，无可用 Runner 时回退到服务端直接执行。
 * 上游/网络错误与脚本输出均原文透传。
 */
export const POST = handleRoute(async (req, _ctx, user) => {
  const input = inputSchema.parse(await req.json()) as ExecuteRequestInput & { itemId?: string };
  // 长连接协议（websocket/socketio/mqtt/mcp/grpc）不能走一次性 HTTP 执行链路，应由前端经实时网关执行
  const protocol = (input.request as { protocol?: string }).protocol ?? "http";
  if (!["http", "graphql", "ai"].includes(protocol)) {
    throw new HttpError(
      400,
      "UNSUPPORTED_PROTOCOL",
      `协议 ${protocol} 是长连接协议，请通过实时网关（gateway）执行，而非一次性请求执行接口`,
    );
  }
  // viewer 也允许发送请求（与 Postman 一致，只读成员仍可调试）
  const { teamId } = await requireWorkspaceRole(input.workspaceId, user.id, "viewer");

  // 检查是否启用 Runner 模式（默认启用，可通过环境变量禁用）
  const useRunner = process.env.DISABLE_RUNNER_EXECUTION !== "true";
  const hasRunner = await hasAvailableRunner(teamId);

  if (useRunner && hasRunner) {
    // Runner 模式：派发任务并同步等待结果
    const result = await dispatchAndWait({
      workspaceId: input.workspaceId,
      teamId,
      userId: user.id,
      targetType: "request",
      targetId: input.itemId ?? crypto.randomUUID(), // 无 itemId 时用随机 UUID
      targetName: input.name ?? "Untitled Request",
      environmentId: input.environmentId ?? null,
      requestConfig: input.request, // 直接传入请求配置，跳过库中展开
      timeoutMs: 60_000, // 60 秒超时
    });
    // Runner 路径不经过 executeRequest，需要手动写入 histories
    // （与 executor.ts 的行为一致：失败也记录，保留现场）
    try {
      await db.insert(histories).values({
        workspaceId: input.workspaceId,
        userId: user.id,
        name: input.name ?? null,
        request: input.request,
        response: result.ok
          ? {
              status: result.status!,
              statusText: result.statusText ?? "",
              sizeBytes: result.sizeBytes ?? 0,
              durationMs: result.durationMs ?? 0,
              headers: result.headers,
              bodyText: result.bodyText,
              bodyBase64: result.bodyBase64,
              cookies: result.cookies,
              testResults: result.testResults,
              consoleLogs: result.consoleLogs,
            }
          : null,
        error: result.ok ? null : (result.error ?? "unknown error"),
      });
    } catch (historyErr) {
      console.error("[execute] failed to persist history (runner path):", historyErr);
    }
    return ok(result);
  }

  // 回退模式：服务端直接执行（用于调试或 Runner 不可用时）
  const result = await executeRequest(input, user.id);
  return ok(result);
});
