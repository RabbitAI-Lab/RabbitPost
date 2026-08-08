/**
 * 实时（长连接协议）通道地基：浏览器 ⇄ api ⇄ runner。
 *
 * 拓扑：浏览器 ──POST/SSE──▶ api ──NDJSON downlink──▶ runner ──▶ 目标服务。
 * 帧契约与 apps/gateway/src/types.ts 完全一致（ServerMessage 形状：status/message/error）。
 *
 * 会话与 downlink 状态全部保存在 api 进程内存中（单实例假设）：
 * 多实例部署或进程重启后，session 全部失效，需要客户端重建。
 */
import { getEmbeddedRunnerId } from "./embedded-runner";
import { HttpError } from "./http";

// ---------------------------------------------------------------------------
// 帧契约（与 apps/gateway/src/types.ts 保持一致，勿单独改动）
// ---------------------------------------------------------------------------

export const RT_PROTOCOLS = [
  "websocket",
  "socketio",
  "mqtt",
  "mcp",
  "grpc",
  "sse",
  "graphql-subscription",
] as const;

export type RtProtocol = (typeof RT_PROTOCOLS)[number];

/** runner → api → 浏览器 的事件帧（ServerMessage；id 由 api 盖章为 sessionId） */
export type RtServerMessage =
  | {
      t: "status";
      id: string;
      state: "connecting" | "open" | "closed" | "error";
      code?: number;
      reason?: string;
    }
  | {
      t: "message";
      id: string;
      dir: "in" | "out";
      data: string;
      encoding: "text" | "base64";
      ts: number;
    }
  | { t: "error"; id?: string; message: string };

/** api → runner 的 downlink 指令（NDJSON 每行一条） */
export type RtCommand =
  | {
      cmd: "start";
      sessionId: string;
      protocol: RtProtocol;
      url: string;
      config?: Record<string, unknown>;
    }
  | { cmd: "send"; sessionId: string; data: string; encoding?: "text" | "base64" }
  | { cmd: "close"; sessionId: string };

/** downlink 写入端：把一条指令写到 runner 的流上；返回 false 表示流已不可用 */
export type RtDownlinkWriter = (cmd: RtCommand) => boolean;

// ---------------------------------------------------------------------------
// 进程内状态（单实例假设）
// ---------------------------------------------------------------------------

interface RtSession {
  id: string;
  workspaceId: string;
  runnerId: string;
  /** SSE 监听器（通常只有一条浏览器连接，但允许重连叠加，断开时各自清理） */
  listeners: Set<(msg: RtServerMessage) => void>;
  /**
   * 事件积压队列（上限 500 条，满则丢最旧）：SSE 订阅建立前 runner 就可能回传
   * connecting/open 等事件（本地回环尤其快），订阅时回放，保证客户端不丢早期事件。
   */
  backlog: RtServerMessage[];
}

interface RtLink {
  runnerId: string;
  isEmbedded: boolean;
  write: RtDownlinkWriter;
}

const sessions = new Map<string, RtSession>();
const links = new Map<string, RtLink>();

// ---------------------------------------------------------------------------
// runner rt link 注册表
// ---------------------------------------------------------------------------

/**
 * 注册一条 runner 的 rt downlink；返回注销函数（连接断开/结束时调用）。
 * 同一 runner 重复注册时旧链接被替换（runner 重连场景）。
 */
export function registerRtLink(
  runnerId: string,
  isEmbedded: boolean,
  write: RtDownlinkWriter,
): () => void {
  links.set(runnerId, { runnerId, isEmbedded, write });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    // 仅当自己仍是当前注册链接时才移除（避免重连后的新链接被旧注销误删）
    if (links.get(runnerId)?.write === write) links.delete(runnerId);
    // 该 runner 名下 session 全部置为 error 并通知对应 SSE（runner 断线无法恢复会话）
    for (const [id, s] of sessions) {
      if (s.runnerId !== runnerId) continue;
      emit(s, { t: "status", id, state: "error", reason: "runner rt link disconnected" });
      emit(s, { t: "error", id, message: "runner rt link disconnected" });
      sessions.delete(id);
    }
  };
}

/**
 * 选择一条持有活跃 rt link 的 runner。
 * 优先内嵌 runner（本地开发开箱即用）；后续可按 team / workspace 路由细化。
 */
export function pickRtRunner(): RtLink | null {
  const embeddedId = getEmbeddedRunnerId();
  if (embeddedId) {
    const embedded = links.get(embeddedId);
    if (embedded) return embedded;
  }
  // 退而求其次：任一活跃链接（内嵌优先：先扫内嵌项）
  for (const link of links.values()) {
    if (link.isEmbedded) return link;
  }
  for (const link of links.values()) return link;
  return null;
}

/** 是否存在任一活跃 rt link（路由层 503 判定） */
export function hasRtRunner(): boolean {
  return links.size > 0;
}

// ---------------------------------------------------------------------------
// session 生命周期
// ---------------------------------------------------------------------------

export interface CreateRtSessionInput {
  workspaceId: string;
  protocol: RtProtocol;
  url: string;
  config?: Record<string, unknown>;
}

/**
 * 创建 rt session 并指派给一条 runner（立即下发 start 指令）。
 * 无可用 runner → 503 NO_RUNNER_AVAILABLE。
 */
export function createRtSession(input: CreateRtSessionInput): { sessionId: string } {
  const link = pickRtRunner();
  if (!link) {
    throw new HttpError(
      503,
      "NO_RUNNER_AVAILABLE",
      "No runner with an active realtime link available",
    );
  }
  const sessionId = crypto.randomUUID();
  const session: RtSession = {
    id: sessionId,
    workspaceId: input.workspaceId,
    runnerId: link.runnerId,
    listeners: new Set(),
    backlog: [],
  };
  sessions.set(sessionId, session);
  // start 下发失败（流刚好断了）时回滚，避免留下永远收不到事件的僵尸 session
  if (
    !link.write({
      cmd: "start",
      sessionId,
      protocol: input.protocol,
      url: input.url,
      config: input.config,
    })
  ) {
    sessions.delete(sessionId);
    throw new HttpError(
      503,
      "NO_RUNNER_AVAILABLE",
      "Runner realtime link closed while starting session",
    );
  }
  return { sessionId };
}

/** 取 session（不存在 → 404）；供路由层做权限级联与存在性校验 */
export function getRtSession(sessionId: string): { workspaceId: string } {
  const s = sessions.get(sessionId);
  if (!s) throw new HttpError(404, "NOT_FOUND", "Realtime session not found");
  return { workspaceId: s.workspaceId };
}

/** 浏览器上行：经 downlink 转发给 runner */
export function sendToRtSession(
  sessionId: string,
  data: string,
  encoding: "text" | "base64",
): void {
  const s = sessions.get(sessionId);
  if (!s) throw new HttpError(404, "NOT_FOUND", "Realtime session not found");
  const link = links.get(s.runnerId);
  if (!link || !link.write({ cmd: "send", sessionId, data, encoding })) {
    throw new HttpError(503, "RUNNER_LINK_LOST", "Runner realtime link is no longer available");
  }
}

/** 关闭 session：尽力通知 runner，清理内存并通知 SSE */
export function closeRtSession(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) throw new HttpError(404, "NOT_FOUND", "Realtime session not found");
  sessions.delete(sessionId);
  // runner 可能已断线：尽力下发 close，失败不影响本地清理
  links.get(s.runnerId)?.write({ cmd: "close", sessionId });
  emit(s, { t: "status", id: sessionId, state: "closed", reason: "closed by client" });
}

/** 订阅 session 事件（SSE）；先回放积压事件再推实时事件；返回退订函数（浏览器断开时调用清理） */
export function subscribeRtSession(
  sessionId: string,
  listener: (msg: RtServerMessage) => void,
): () => void {
  const s = sessions.get(sessionId);
  if (!s) throw new HttpError(404, "NOT_FOUND", "Realtime session not found");
  s.listeners.add(listener);
  // 回放订阅前积压的事件（顺序：积压在前，后续实时事件由 emit 同步推送）
  for (const msg of s.backlog) {
    try {
      listener(msg);
    } catch {
      // 监听器异常不影响回放
    }
  }
  return () => {
    s.listeners.delete(listener);
  };
}

/**
 * runner 上行事件入口：写入该 session 的 SSE 队列。
 * id 一律以 api 侧 sessionId 盖章，不信任 runner 上报的 id 值。
 */
export function pushRtEvent(
  sessionId: string,
  event: Omit<RtServerMessage, "id"> & { id?: string },
): void {
  const s = sessions.get(sessionId);
  if (!s) throw new HttpError(404, "NOT_FOUND", "Realtime session not found");
  emit(s, { ...event, id: sessionId } as RtServerMessage);
}

function emit(s: RtSession, msg: RtServerMessage): void {
  s.backlog.push(msg);
  if (s.backlog.length > 500) s.backlog.shift();
  for (const fn of s.listeners) {
    try {
      fn(msg);
    } catch {
      // 单个监听器异常（流已关闭等）不影响其它监听器
    }
  }
}

/** 测试用：清空全部进程内状态 */
export function resetRtState(): void {
  sessions.clear();
  links.clear();
}
