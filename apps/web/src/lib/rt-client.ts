/**
 * 长连接协议的浏览器端客户端（经 apps/api 实时桥 + runner 执行）：
 * - 创建 session / 发消息 / 关闭 走 POST，事件下行走 SSE（EventSource）
 * - 帧格式（status/message/error）与 apps/api/src/lib/rt.ts 的 ServerMessage 一致
 * - 桌面模式：session 改道本机 local-agent（127.0.0.1），不经过服务器
 */

import { detectLocalAgent } from "./local-agent";

export type RtProtocol =
  | "websocket"
  | "socketio"
  | "mqtt"
  | "mcp"
  | "grpc"
  | "sse"
  | "graphql-subscription";

export interface RtSessionEvent {
  type: "status" | "message" | "error";
  state?: "connecting" | "open" | "closed" | "error";
  code?: number;
  reason?: string;
  dir?: "in" | "out";
  data?: string;
  encoding?: "text" | "base64";
  ts?: number;
  message?: string;
}

type SessionListener = (event: RtSessionEvent) => void;

interface SessionHandle {
  sessionId: string;
  events: EventSource;
  listener: SessionListener;
  /** 本次会话的执行端 base："" = 服务器；http://127.0.0.1:port = 桌面本地 agent */
  base: string;
}

/** 桌面模式优先本地 agent（本机执行长连接协议）；不可用回退服务器 */
async function rtBase(): Promise<string> {
  return (await detectLocalAgent()) ?? "";
}

/** 统一解 API 信封，失败抛出 error.message */
async function apiCall<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = (await res.json()) as {
    ok: boolean;
    data?: T;
    error?: { message?: string };
  };
  if (!res.ok || !body.ok) {
    throw new Error(body.error?.message ?? `请求失败（HTTP ${res.status}）`);
  }
  return body.data as T;
}

class RtClient {
  /** key（tab.key）→ session */
  private sessions = new Map<string, SessionHandle>();

  /** 建立协议 session；listener 收到 open 后可调用 send */
  async connect(args: {
    id: string;
    protocol: RtProtocol;
    url: string;
    config?: Record<string, unknown>;
    workspaceId: string;
    onEvent: SessionListener;
  }): Promise<void> {
    // 幂等：同 key 重复 connect 先清掉旧 session
    this.close(args.id);

    const base = await rtBase();
    const { sessionId } = await apiCall<{ sessionId: string }>(
      `${base}/api/v1/rt/sessions`,
      {
        method: "POST",
        body: JSON.stringify({
          workspaceId: args.workspaceId,
          protocol: args.protocol,
          url: args.url,
          config: args.config,
        }),
      },
    );

    const events = new EventSource(`${base}/api/v1/rt/sessions/${sessionId}/events`);
    const handle: SessionHandle = { sessionId, events, listener: args.onEvent, base };
    this.sessions.set(args.id, handle);

    events.onmessage = (e) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(e.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.t === "status") {
        handle.listener({
          type: "status",
          state: msg.state as RtSessionEvent["state"],
          code: msg.code as number | undefined,
          reason: msg.reason as string | undefined,
        });
      } else if (msg.t === "message") {
        handle.listener({
          type: "message",
          dir: msg.dir as "in" | "out",
          data: msg.data as string,
          encoding: msg.encoding as "text" | "base64",
          ts: msg.ts as number,
        });
      } else if (msg.t === "error") {
        handle.listener({ type: "error", message: msg.message as string });
      }
    };
    // SSE 断开（网络抖动 / 服务重启）：通知 session 已关闭
    events.onerror = () => {
      if (events.readyState === EventSource.CLOSED) {
        handle.listener({ type: "status", state: "closed", reason: "事件流断开" });
        this.sessions.delete(args.id);
      }
    };
  }

  send(id: string, data: string, encoding: "text" | "base64" = "text"): void {
    const session = this.sessions.get(id);
    if (!session) return;
    void apiCall(`${session.base}/api/v1/rt/sessions/${session.sessionId}/send`, {
      method: "POST",
      body: JSON.stringify({ data, encoding }),
    }).catch((e) => {
      session.listener({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    });
  }

  close(id: string, _code?: number, _reason?: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.events.close();
    void fetch(`${session.base}/api/v1/rt/sessions/${session.sessionId}`, {
      method: "DELETE",
    }).catch(() => {});
  }
}

export const rtClient = new RtClient();
