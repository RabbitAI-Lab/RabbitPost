import type {
  Environment,
  ExecuteResult,
  KeyValueItem,
  RequestConfig,
  ResolvedDbConnection,
} from "@rabbitpost/shared";
import { resolveRequestSettings, substituteVariables } from "@rabbitpost/shared";
import { dbConnectionsApi, executeApi, historyApi } from "../api";
import { newKvItem } from "../components/common/KeyValueEditor";
import { useAppStore } from "../stores/app";
import { cookieHeaderForUrl, hostnameOf, useCookiesStore } from "../stores/cookies";
import { detectLocalAgent, invalidateLocalAgent } from "./local-agent";

/**
 * 构建变量映射（globals 垫底，Collection 覆盖，Environment 最高，与服务端及 Postman 一致）。
 * executeRequestConfig 与长连接协议编辑器（WebSocket 等）共用。
 */
export function buildVariableMap(args: {
  environmentId: string | null;
  environments: Environment[];
  collectionVariables?: KeyValueItem[];
  globalVariables?: KeyValueItem[];
}): Record<string, string> {
  const { environmentId, environments, collectionVariables, globalVariables } = args;
  const toMap = (items: KeyValueItem[] | undefined) =>
    Object.fromEntries(
      (items ?? []).filter((v) => v.enabled && v.key).map((v) => [v.key, v.value]),
    );
  const env = environments.find((e) => e.id === environmentId);
  return {
    ...toMap(globalVariables),
    ...toMap(collectionVariables),
    ...toMap(env?.variables),
  };
}

/**
 * 桌面模式下经本地 agent（rabbitpost-runner local-agent）执行：
 * 请求与变量表直接发给本机代理，不经过服务器。返回与服务端一致的 ExecuteResult。
 */
async function executeViaAgent(args: {
  base: string;
  workspaceId: string;
  environmentId: string | null;
  name: string;
  request: RequestConfig;
  itemId?: string;
  variables: Record<string, string>;
  /** 已解密的数据库连接（含明文密码；仅 local-agent 路径下发，与 variables 现状一致） */
  dbConnections?: ResolvedDbConnection[];
}): Promise<ExecuteResult> {
  const resp = await fetch(`${args.base}/api/v1/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: args.workspaceId,
      environmentId: args.environmentId,
      name: args.name,
      itemId: args.itemId,
      request: args.request,
      variables: args.variables,
      ...(args.dbConnections ? { dbConnections: args.dbConnections } : {}),
    }),
  });
  const body = (await resp.json()) as
    | { ok: true; data: ExecuteResult }
    | { ok: false; error: { message: string } };
  if (!resp.ok || !body.ok) {
    throw new Error(body.ok ? `本地执行失败（HTTP ${resp.status}）` : body.error.message);
  }
  return body.data;
}

/** 本地执行完成后把结果上报服务器写入 History（尽力而为，失败静默） */
function reportLocalHistory(args: {
  workspaceId: string;
  name: string;
  request: RequestConfig;
  result: ExecuteResult;
}): void {
  const { workspaceId, name, request, result } = args;
  void historyApi
    .report(workspaceId, {
      name,
      request,
      response: result.ok
        ? {
            status: result.status ?? 0,
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
    })
    .catch(() => {});
}

/**
 * 执行一个请求配置（接口 Send / 用例 Run 共用）：
 * 环境变量替换 URL → Cookie Jar 合并 → 调用执行接口 → Set-Cookie 写回 Jar → 通知 History 刷新
 *
 * 桌面模式且本地 agent 可用时，请求在本机执行（不经服务器），
 * 执行结果回传服务器写入 History；agent 中途失败时回退服务器执行。
 */
export async function executeRequestConfig(args: {
  workspaceId: string;
  environmentId: string | null;
  environments: Environment[];
  name: string;
  config: RequestConfig;
  /** Collection Item ID，用于 Runner 模式关联已保存的请求 */
  itemId?: string;
  /** 所属 Collection 的变量（作用域为当前 Collection，优先级低于 Environment） */
  collectionVariables?: KeyValueItem[];
  /** Workspace 级全局变量（跨 Collection 可用，优先级最低） */
  globalVariables?: KeyValueItem[];
}): Promise<ExecuteResult> {
  const { workspaceId, environmentId, environments, name, config, itemId, collectionVariables, globalVariables } =
    args;
  const settings = resolveRequestSettings(config.settings);
  const vars = buildVariableMap({ environmentId, environments, collectionVariables, globalVariables });
  const resolvedUrl = substituteVariables(config.url, vars);
  // Disable cookie jar：本请求不带上已存 cookie
  const jarCookie = settings.disableCookieJar
    ? ""
    : cookieHeaderForUrl(resolvedUrl, useCookiesStore.getState().domains);
  let request = config;
  if (jarCookie) {
    const userCookie = config.headers.find(
      (h) => h.enabled && h.key.toLowerCase() === "cookie",
    );
    // 用户已手写 Cookie 头时合并到同一个头，避免重复 Cookie 头
    request = userCookie
      ? {
          ...config,
          headers: config.headers.map((h) =>
            h.id === userCookie.id
              ? { ...h, value: h.value ? `${h.value}; ${jarCookie}` : jarCookie }
              : h,
          ),
        }
      : {
          ...config,
          headers: [...config.headers, newKvItem({ key: "Cookie", value: jarCookie })],
        };
  }
  let result: ExecuteResult;
  const agentBase = await detectLocalAgent();
  if (agentBase) {
    try {
      // REST 不回传连接密码，local-agent 需要明文：经 resolve 端点由服务端解密下发；
      // 仅当 workspace 配了连接时才拉取。拉取失败（如 viewer 角色）降级为不带连接执行
      let dbConnections: ResolvedDbConnection[] | undefined;
      if (useAppStore.getState().dbConnections.length > 0) {
        dbConnections = await dbConnectionsApi
          .resolve(workspaceId, environmentId)
          .catch(() => undefined);
      }
      result = await executeViaAgent({
        base: agentBase,
        workspaceId,
        environmentId,
        name,
        request,
        itemId,
        variables: vars,
        dbConnections,
      });
      reportLocalHistory({ workspaceId, name, request, result });
    } catch {
      // agent 中途退出/网络异常：缓存失效，回退服务器执行
      invalidateLocalAgent();
      result = await executeApi.run({ workspaceId, environmentId, name, request, itemId });
    }
  } else {
    result = await executeApi.run({ workspaceId, environmentId, name, request, itemId });
  }
  // 响应的 Set-Cookie 自动写回 Cookie Jar（同 Postman）；Disable cookie jar 时不写回
  const host = hostnameOf(resolvedUrl);
  if (!settings.disableCookieJar && host && result.cookies?.length) {
    useCookiesStore.getState().storeResponseCookies(host, result.cookies);
  }
  // 通知 History 面板刷新
  window.dispatchEvent(new CustomEvent("rabbitpost:history-updated"));
  return result;
}
