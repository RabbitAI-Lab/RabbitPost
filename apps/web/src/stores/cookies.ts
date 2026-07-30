import type { ResponseCookie } from "@rabbitpost/shared";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Cookie Jar 中的单条 cookie：以 Set-Cookie 风格原始串存储（同 Postman 编辑形态） */
export interface JarCookie {
  id: string;
  /** 形如 "Cookie_1=value; Path=/; Expires=Tue, 19 Jan 2038 03:14:07 GMT;" */
  raw: string;
}

/** 按域名分组的 cookie 集合 */
export interface JarDomain {
  domain: string;
  cookies: JarCookie[];
}

/** raw cookie 串解析结果（属性名大小写不敏感） */
export interface ParsedCookie {
  name: string;
  value: string;
  path: string;
  domain?: string;
  expires?: string;
  secure: boolean;
  httpOnly: boolean;
}

let seq = 0;
function newCookieId(): string {
  return `ck-${Date.now()}-${seq++}`;
}

/** 解析 "name=value; Attr=..." 形式的 cookie 串；无 name 时返回 null */
export function parseRawCookie(raw: string): ParsedCookie | null {
  const segments = raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const first = segments.shift();
  if (!first) return null;
  const eq = first.indexOf("=");
  const name = (eq >= 0 ? first.slice(0, eq) : first).trim();
  if (!name) return null;
  const cookie: ParsedCookie = {
    name,
    value: eq >= 0 ? first.slice(eq + 1).trim() : "",
    path: "/",
    secure: false,
    httpOnly: false,
  };
  for (const seg of segments) {
    const i = seg.indexOf("=");
    const key = (i >= 0 ? seg.slice(0, i) : seg).trim().toLowerCase();
    const val = i >= 0 ? seg.slice(i + 1).trim() : "";
    if (key === "path" && val) cookie.path = val;
    else if (key === "domain" && val) cookie.domain = val.replace(/^\./, "");
    else if (key === "expires") cookie.expires = val;
    else if (key === "max-age" && val) {
      const n = Number(val);
      if (!Number.isNaN(n)) cookie.expires = new Date(Date.now() + n * 1000).toUTCString();
    } else if (key === "secure") cookie.secure = true;
    else if (key === "httponly") cookie.httpOnly = true;
  }
  return cookie;
}

/** 规范化用户输入的域名：去掉协议 / 路径 / 端口 / 前导点，转小写 */
export function normalizeDomainInput(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^\./, "");
}

/** cookie 是否已过期（Expires 可解析且早于当前时间） */
function isExpired(expires: string | undefined): boolean {
  if (!expires) return false;
  const t = Date.parse(expires);
  return !Number.isNaN(t) && t < Date.now();
}

/**
 * 依据 URL 从 Cookie Jar 中筛出可发送的 cookie，拼为 Cookie 请求头值。
 * 匹配规则同浏览器：域名后缀匹配、路径前缀匹配、Secure 仅 https、过期跳过。
 */
export function cookieHeaderForUrl(rawUrl: string, domains: JarDomain[]): string {
  let url: URL;
  try {
    // 与服务端 executor 一致：缺协议时补 http://
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`);
  } catch {
    return "";
  }
  const host = url.hostname.toLowerCase();
  const pairs: string[] = [];
  const seen = new Set<string>();
  for (const d of domains) {
    for (const c of d.cookies) {
      const parsed = parseRawCookie(c.raw);
      if (!parsed) continue;
      const domain = (parsed.domain ?? d.domain).toLowerCase();
      if (host !== domain && !host.endsWith(`.${domain}`)) continue;
      if (!url.pathname.startsWith(parsed.path)) continue;
      if (parsed.secure && url.protocol !== "https:") continue;
      if (isExpired(parsed.expires)) continue;
      if (seen.has(parsed.name)) continue;
      seen.add(parsed.name);
      pairs.push(`${parsed.name}=${parsed.value}`);
    }
  }
  return pairs.join("; ");
}

/** 从 URL 提取 hostname；非法 URL 返回 null */
export function hostnameOf(rawUrl: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 将响应解析出的 ResponseCookie 还原为 raw 串 */
function buildRaw(c: ResponseCookie): string {
  const parts = [`${c.name}=${c.value}`];
  parts.push(`Path=${c.path ?? "/"}`);
  if (c.domain) parts.push(`Domain=${c.domain.replace(/^\./, "")}`);
  if (c.expires) parts.push(`Expires=${c.expires}`);
  else if (c.maxAge !== undefined)
    parts.push(`Expires=${new Date(Date.now() + c.maxAge * 1000).toUTCString()}`);
  if (c.secure) parts.push("Secure");
  if (c.httpOnly) parts.push("HttpOnly");
  return `${parts.join("; ")};`;
}

interface CookiesState {
  domains: JarDomain[];
  /** 允许脚本编程访问 cookie 的域名白名单（同 Postman Domains allowlist） */
  allowlist: string[];

  addDomain: (domain: string) => void;
  removeDomain: (domain: string) => void;
  /** id 为 null 时新增，否则更新对应 cookie 的 raw 串 */
  upsertCookie: (domain: string, id: string | null, raw: string) => void;
  removeCookie: (domain: string, id: string) => void;
  clearAll: () => void;
  addAllowlistDomain: (domain: string) => void;
  removeAllowlistDomain: (domain: string) => void;
  /** 将响应 Set-Cookie 写入 Jar：同名覆盖，已过期则删除（同浏览器语义） */
  storeResponseCookies: (host: string, cookies: ResponseCookie[]) => void;
}

export const useCookiesStore = create<CookiesState>()(
  persist(
    (set) => ({
      domains: [],
      allowlist: [],

      addDomain: (domain) =>
        set((s) =>
          s.domains.some((d) => d.domain === domain)
            ? s
            : { domains: [...s.domains, { domain, cookies: [] }] },
        ),

      removeDomain: (domain) =>
        set((s) => ({ domains: s.domains.filter((d) => d.domain !== domain) })),

      upsertCookie: (domain, id, raw) =>
        set((s) => ({
          domains: s.domains.map((d) =>
            d.domain !== domain
              ? d
              : {
                  ...d,
                  cookies: id
                    ? d.cookies.map((c) => (c.id === id ? { ...c, raw } : c))
                    : [...d.cookies, { id: newCookieId(), raw }],
                },
          ),
        })),

      removeCookie: (domain, id) =>
        set((s) => ({
          domains: s.domains.map((d) =>
            d.domain !== domain
              ? d
              : { ...d, cookies: d.cookies.filter((c) => c.id !== id) },
          ),
        })),

      clearAll: () => set({ domains: [] }),

      addAllowlistDomain: (domain) =>
        set((s) =>
          s.allowlist.includes(domain) ? s : { allowlist: [...s.allowlist, domain] },
        ),

      removeAllowlistDomain: (domain) =>
        set((s) => ({ allowlist: s.allowlist.filter((d) => d !== domain) })),

      storeResponseCookies: (host, cookies) =>
        set((s) => {
          let domains = [...s.domains];
          for (const c of cookies) {
            if (!c.name) continue;
            const domain = (c.domain ?? host).replace(/^\./, "").toLowerCase();
            const expired =
              (c.maxAge !== undefined && c.maxAge <= 0) || isExpired(c.expires);
            let entry = domains.find((d) => d.domain === domain);
            if (!entry) {
              if (expired) continue;
              entry = { domain, cookies: [] };
              domains.push(entry);
            }
            // 同名 cookie 覆盖；过期视为删除
            const rest = entry.cookies.filter(
              (k) => parseRawCookie(k.raw)?.name !== c.name,
            );
            const next = expired ? rest : [...rest, { id: newCookieId(), raw: buildRaw(c) }];
            domains = domains.map((d) =>
              d.domain === domain ? { ...d, cookies: next } : d,
            );
          }
          return { domains };
        }),
    }),
    { name: "rp.cookies" },
  ),
);
