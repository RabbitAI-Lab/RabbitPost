import { App } from "antd";
import { useEffect, useRef, useState } from "react";
import { substituteVariables } from "@rabbitpost/shared";
import { buildVariableMap } from "../../../lib/execute";
import { rtClient, type RtProtocol } from "../../../lib/rt-client";
import { useAppStore } from "../../../stores/app";
import type { RequestTab } from "../../../stores/tabs";
import type { MessageLogEntry } from "../MessageLog";

export type ConnState = "idle" | "connecting" | "open" | "closed";

interface Args {
  tab: RequestTab;
  protocol: RtProtocol;
  /** 校验并返回替换变量后的最终连接地址；非法时返回 null（hook 内统一提示） */
  resolveUrl: (rawUrl: string, vars: Record<string, string>) => string | null;
  /** 各协议的连接配置（headers/auth/path 等），随 connect 发给 Runner */
  buildConfig?: (vars: Record<string, string>) => Record<string, unknown>;
  /** 把 Runner 回传的消息格式化为时间线文本；默认原样（base64 加前缀） */
  formatMessage?: (dir: "in" | "out", data: string, encoding: "text" | "base64") => string;
  /** 原始事件透传（如 MCP 需要从 serverInfo 消息中提取服务器能力信息） */
  onRawEvent?: (ev: {
    type: "status" | "message" | "error";
    dir?: "in" | "out";
    data?: string;
  }) => void;
}

/**
 * 长连接协议编辑器共用的连接管理 hook：
 * 封装 rtClient（api 实时桥 + runner 执行）的 connect/send/close、事件 → MessageLogEntry 时间线、卸载自动断开。
 */
export function useRtConnection({
  tab,
  protocol,
  resolveUrl,
  buildConfig,
  formatMessage,
  onRawEvent,
}: Args) {
  const { message } = App.useApp();
  const { currentWorkspaceId, activeEnvironmentId, environments, collections } =
    useAppStore();

  const [connState, setConnState] = useState<ConnState>("idle");
  const [entries, setEntries] = useState<MessageLogEntry[]>([]);
  const nextId = useRef(1);
  const connectedRef = useRef(false);
  /** whenOpen 的等待者：open 时 resolve(true)，error/closed 时 resolve(false) */
  const openWaitersRef = useRef<((ok: boolean) => void)[]>([]);
  const settleOpenWaiters = (ok: boolean) => {
    openWaitersRef.current.splice(0).forEach((fn) => fn(ok));
  };

  const pushEntry = (dir: MessageLogEntry["dir"], text: string, ts?: number) => {
    setEntries((prev) => [
      ...prev,
      { id: nextId.current++, dir, text, ts: ts ?? Date.now() },
    ]);
  };

  const resolveVars = () =>
    buildVariableMap({
      environmentId: activeEnvironmentId,
      environments,
      collectionVariables: collections.find((c) => c.id === tab.collectionId)?.variables,
    });

  const connect = async () => {
    const vars = resolveVars();
    const url = resolveUrl(tab.config.url, vars);
    if (!url) {
      message.warning("请输入合法的连接地址");
      return;
    }
    if (!currentWorkspaceId) {
      message.warning("请先选择 Workspace");
      return;
    }
    setEntries([]);
    setConnState("connecting");
    try {
      await rtClient.connect({
        id: tab.key,
        protocol,
        url,
        config: buildConfig?.(vars),
        workspaceId: currentWorkspaceId,
        onEvent: (ev) => {
          if (ev.type === "status") {
            if (ev.state === "open") {
              connectedRef.current = true;
              setConnState("open");
              settleOpenWaiters(true);
              pushEntry("system", `已连接 ${url}`);
            } else if (ev.state === "closed") {
              connectedRef.current = false;
              setConnState("closed");
              settleOpenWaiters(false);
              pushEntry(
                "system",
                `连接已关闭${ev.reason ? `：${ev.reason}` : ev.code ? `（code ${ev.code}）` : ""}`,
              );
            } else if (ev.state === "error") {
              connectedRef.current = false;
              setConnState("closed");
              settleOpenWaiters(false);
              pushEntry("system", `连接失败：${ev.reason ?? "未知错误"}`);
            }
          } else if (ev.type === "message") {
            onRawEvent?.({ type: "message", dir: ev.dir, data: ev.data });
            const text = formatMessage
              ? formatMessage(ev.dir!, ev.data ?? "", ev.encoding ?? "text")
              : ev.encoding === "base64"
                ? `[binary base64] ${ev.data}`
                : (ev.data ?? "");
            pushEntry(ev.dir!, text, ev.ts);
          } else if (ev.type === "error") {
            pushEntry("system", `错误：${ev.message}`);
          }
        },
      });
    } catch (e) {
      setConnState("idle");
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  const disconnect = () => {
    rtClient.close(tab.key);
    connectedRef.current = false;
  };

  const sendRaw = (data: string, encoding: "text" | "base64" = "text") => {
    rtClient.send(tab.key, data, encoding);
  };

  useEffect(() => {
    return () => {
      if (connectedRef.current) rtClient.close(tab.key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.key]);

  return {
    connState,
    entries,
    clearEntries: () => setEntries([]),
    connect,
    disconnect,
    sendRaw,
    resolveVars,
    connected: connState === "open",
    /** 等待连接进入 open（已在 open 态立即返回 true；error/closed 返回 false） */
    whenOpen: () => {
      if (connectedRef.current) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        openWaitersRef.current.push(resolve);
      });
    },
  };
}
