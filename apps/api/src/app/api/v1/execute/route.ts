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
import { executeRequest } from "../../../../lib/executor";
import { handleRoute, ok, requireWorkspaceRole } from "../../../../lib/http";

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
});

/**
 * POST /api/v1/execute
 * 服务端代理执行 HTTP 请求（避开浏览器 CORS）。
 * 上游/网络错误与脚本输出均原文透传。
 */
export const POST = handleRoute(async (req, _ctx, user) => {
  const input = inputSchema.parse(await req.json()) as ExecuteRequestInput;
  // viewer 也允许发送请求（与 Postman 一致，只读成员仍可调试）
  await requireWorkspaceRole(input.workspaceId, user.id, "viewer");
  const result = await executeRequest(input, user.id);
  return ok(result);
});
