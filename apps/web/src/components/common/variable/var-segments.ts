/** {{varName}} 变量匹配（与 shared 包 substituteVariables 规则一致） */
export const VAR_RE = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** 胡萝卜橙：变量已在当前环境中解析 */
export const COLOR_RESOLVED = "#ff6c37";
/** 红色：变量未找到 */
export const COLOR_UNRESOLVED = "#ff4d4f";

export interface Segment {
  text: string;
  varName?: string;
}

export interface EnvVarInfo {
  value: string;
  secret?: boolean;
}

export type EnvVarMap = Record<string, EnvVarInfo>;

/** 把文本拆分为普通文本与 {{var}} 变量片段 */
export function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(VAR_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) segments.push({ text: text.slice(last, idx) });
    segments.push({ text: m[0], varName: m[1] });
    last = idx + m[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}
