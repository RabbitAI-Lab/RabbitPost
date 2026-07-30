import type { ApiResponse } from "@rabbitpost/shared";

/** API 调用异常：保留服务端透传的原始错误信息 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public upstreamBody?: unknown,
  ) {
    super(message);
  }
}

/** 统一 fetch 封装：同源携带会话 cookie，解包 ApiResponse 信封 */
export async function api<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = init ?? {};
  const resp = await fetch(path, {
    credentials: "include",
    ...rest,
    headers: {
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...rest.headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });

  let envelope: ApiResponse<T>;
  const text = await resp.text();
  try {
    envelope = JSON.parse(text) as ApiResponse<T>;
  } catch {
    // 非 JSON 响应原文抛出，便于定位网关/代理层问题
    throw new ApiError(resp.status, "NON_JSON_RESPONSE", text || resp.statusText);
  }

  if (!envelope.ok) {
    const e = envelope.error;
    throw new ApiError(resp.status, e.code, e.message, e.upstreamBody);
  }
  return envelope.data;
}
