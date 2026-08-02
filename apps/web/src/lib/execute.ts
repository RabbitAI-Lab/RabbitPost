import type {
  Environment,
  ExecuteResult,
  KeyValueItem,
  RequestConfig,
} from "@rabbitpost/shared";
import { resolveRequestSettings, substituteVariables } from "@rabbitpost/shared";
import { executeApi } from "../api";
import { newKvItem } from "../components/common/KeyValueEditor";
import { cookieHeaderForUrl, hostnameOf, useCookiesStore } from "../stores/cookies";

/**
 * 执行一个请求配置（接口 Send / 用例 Run 共用）：
 * 环境变量替换 URL → Cookie Jar 合并 → 调用执行接口 → Set-Cookie 写回 Jar → 通知 History 刷新
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
}): Promise<ExecuteResult> {
  const { workspaceId, environmentId, environments, name, config, itemId, collectionVariables } =
    args;
  const settings = resolveRequestSettings(config.settings);
  // 变量优先级：Collection 为底，Environment 覆盖（与服务端及 Postman 一致）
  const colVars = Object.fromEntries(
    (collectionVariables ?? [])
      .filter((v) => v.enabled && v.key)
      .map((v) => [v.key, v.value]),
  );
  const env = environments.find((e) => e.id === environmentId);
  const vars = {
    ...colVars,
    ...Object.fromEntries(
      (env?.variables ?? [])
        .filter((v) => v.enabled && v.key)
        .map((v) => [v.key, v.value]),
    ),
  };
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
  const result = await executeApi.run({ workspaceId, environmentId, name, request, itemId });
  // 响应的 Set-Cookie 自动写回 Cookie Jar（同 Postman）；Disable cookie jar 时不写回
  const host = hostnameOf(resolvedUrl);
  if (!settings.disableCookieJar && host && result.cookies?.length) {
    useCookiesStore.getState().storeResponseCookies(host, result.cookies);
  }
  // 通知 History 面板刷新
  window.dispatchEvent(new CustomEvent("rabbitpost:history-updated"));
  return result;
}
