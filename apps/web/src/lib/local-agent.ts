/**
 * 桌面端本地执行代理（rabbitpost-runner local-agent）探测。
 * 仅在 Tauri WebView 中生效：agent 由桌面壳随应用拉起，监听 127.0.0.1 的
 * 固定端口段。探测成功后"执行"类请求改道本地（不经过服务器）。
 */

const BASE_PORT = 17337;
const PORT_RANGE = 10;
const PROBE_TIMEOUT_MS = 800;
/** 探测失败的缓存时长：agent 可能随应用稍后就绪，30s 后允许重新探测 */
const MISS_CACHE_MS = 30_000;

/** 是否运行在 Tauri 桌面壳中 */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let cachedBase: string | null = null;
let lastMissAt = 0;
let probing: Promise<string | null> | null = null;

async function probe(base: string): Promise<boolean> {
  try {
    const resp = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = (await resp.json()) as { ok?: boolean; data?: { mode?: string } };
    return body.ok === true && body.data?.mode === "local-agent";
  } catch {
    return false;
  }
}

/**
 * 探测本地 agent：成功返回 base URL（http://127.0.0.1:<port>），不可用返回 null。
 * 结果带缓存：命中常驻；未命中 30s 内不重复探测（避免每次请求都扫端口段）。
 */
export async function detectLocalAgent(): Promise<string | null> {
  if (!isDesktop()) return null;
  if (cachedBase) return cachedBase;
  if (lastMissAt && Date.now() - lastMissAt < MISS_CACHE_MS) return null;
  probing ??= (async () => {
      for (let port = BASE_PORT; port <= BASE_PORT + PORT_RANGE; port++) {
        const base = `http://127.0.0.1:${port}`;
        if (await probe(base)) {
          cachedBase = base;
          return base;
        }
      }
      lastMissAt = Date.now();
      return null;
    })().finally(() => {
      probing = null;
    });
  return probing;
}

/** agent 调用失败（进程退出等）时使缓存失效，下次执行重新探测/回退 */
export function invalidateLocalAgent(): void {
  cachedBase = null;
  lastMissAt = 0;
}
