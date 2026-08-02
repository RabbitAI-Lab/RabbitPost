import { z } from "zod";
import { err, handleRoute, ok } from "../../../../../lib/http";

const bodySchema = z.object({ url: z.string().url() });

/** 拉取超时与体积上限（导入文件通常远小于此） */
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * POST /api/v1/import/fetch — 服务端拉取在线链接的文本内容。
 * 由服务端代取以规避浏览器 CORS；解析（RabbitPost / Postman）仍在前端完成。
 */
export const POST = handleRoute(async (req) => {
  const { url } = bodySchema.parse(await req.json());
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return err(400, "INVALID_URL", "Only http/https URLs are supported");
  }

  let resp: Response;
  try {
    resp = await fetch(target, {
      redirect: "follow",
      headers: { Accept: "application/json, text/plain, */*" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // 网络层错误原文透传
    return err(502, "FETCH_FAILED", e instanceof Error ? e.message : String(e));
  }

  const text = await resp.text();
  if (!resp.ok) {
    return err(502, "UPSTREAM_ERROR", `${resp.status} ${resp.statusText}`, {
      upstreamStatus: resp.status,
      upstreamBody: text.slice(0, 2000),
    });
  }
  if (text.length > MAX_BYTES) {
    return err(413, "TOO_LARGE", `Response exceeds ${MAX_BYTES} bytes`);
  }

  return ok({
    text,
    contentType: resp.headers.get("content-type"),
    finalUrl: resp.url || target.toString(),
  });
});
