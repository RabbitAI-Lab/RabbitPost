import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectLocalAgent,
  invalidateLocalAgent,
  isDesktop,
} from "../src/lib/local-agent";

/**
 * local-agent 探测的隔离性测试：
 * 浏览器（web 端）永远不触碰本机 127.0.0.1 的 local-agent —— 只走线上 api；
 * 仅 Tauri webview（desktop）才探测并改道本地执行。
 */
function setTauri(on: boolean) {
  const w = window as unknown as Record<string, unknown>;
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

const agentOk = () =>
  new Response(JSON.stringify({ ok: true, data: { mode: "local-agent" } }), {
    status: 200,
  });

beforeEach(() => {
  invalidateLocalAgent();
});

afterEach(() => {
  setTauri(false);
  vi.restoreAllMocks();
});

describe("isDesktop / detectLocalAgent 隔离性", () => {
  it("浏览器环境：不发起任何本机探测，直接返回 null（web 只走线上 api）", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(isDesktop()).toBe(false);
    expect(await detectLocalAgent()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("桌面环境：探测到 agent 返回 base 并缓存（后续不再发请求）", async () => {
    setTauri(true);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(agentOk()));
    const base = await detectLocalAgent();
    expect(base).toBe("http://127.0.0.1:17337");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:17337/health");
    // 命中缓存，不再发请求
    expect(await detectLocalAgent()).toBe(base);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("桌面环境：探测失败返回 null，30s 冷却期内不重复扫描", async () => {
    setTauri(true);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("connect refused"));
    expect(await detectLocalAgent()).toBeNull();
    const calls = fetchSpy.mock.calls.length;
    expect(calls).toBe(11); // 端口段 17337..=17347 各探测一次
    expect(await detectLocalAgent()).toBeNull();
    expect(fetchSpy.mock.calls.length).toBe(calls);
  });

  it("health 响应 mode 不是 local-agent 时不认定（避免撞到同端口的其他服务）", async () => {
    setTauri(true);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { mode: "other" } }), {
        status: 200,
      }),
    );
    expect(await detectLocalAgent()).toBeNull();
  });

  it("invalidateLocalAgent 后允许重新探测", async () => {
    setTauri(true);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(agentOk()));
    await detectLocalAgent();
    invalidateLocalAgent();
    await detectLocalAgent();
    expect(fetchSpy.mock.calls.length).toBe(2);
  });
});
