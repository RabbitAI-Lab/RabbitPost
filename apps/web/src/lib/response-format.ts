import { json as jsonLang } from "@codemirror/lang-json";
import { yaml as yamlLang } from "@codemirror/lang-yaml";
import { xml as xmlLang } from "@codemirror/lang-xml";
import { html as htmlLang } from "@codemirror/lang-html";
import { javascript as jsLang } from "@codemirror/lang-javascript";
import { markdown as mdLang } from "@codemirror/lang-markdown";
import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import YAML from "yaml";

/** Response Body 可切换的显示格式（对齐 Postman） */
export type ResponseFormat =
  | "json"
  | "xml"
  | "html"
  | "yaml"
  | "javascript"
  | "markdown"
  | "raw"
  | "hex"
  | "base64";

export const RESPONSE_FORMATS: ResponseFormat[] = [
  "json",
  "xml",
  "html",
  "yaml",
  "javascript",
  "markdown",
  "raw",
  "hex",
  "base64",
];

export const RESPONSE_FORMAT_LABELS: Record<ResponseFormat, string> = {
  json: "JSON",
  xml: "XML",
  html: "HTML",
  yaml: "YAML",
  javascript: "JavaScript",
  markdown: "Markdown",
  raw: "Raw",
  hex: "Hex",
  base64: "Base64",
};

/**
 * 根据 content-type 自动推断最佳显示格式。
 * 推断不出来时回退到 raw。
 */
export function detectFormat(
  contentType?: string,
  bodyText?: string,
): ResponseFormat {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("json")) return "json";
  if (ct.includes("html")) return "html";
  if (ct.includes("xml")) return "xml";
  if (ct.includes("yaml")) return "yaml";
  if (
    ct.includes("javascript") ||
    ct.includes("ecmascript") ||
    ct.includes("text/js")
  ) {
    return "javascript";
  }
  if (ct.includes("markdown")) return "markdown";
  // 无明确 content-type 时尝试嗅探 JSON
  if (bodyText) {
    const trimmed = bodyText.trimStart();
    if (
      (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
      ct.includes("text")
    ) {
      return "json";
    }
    if (trimmed.startsWith("<")) {
      if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
        return "html";
      }
      return "xml";
    }
  }
  return "raw";
}

/** 简易 XML / HTML 格式化：标签间换行 + 两格缩进（与 RequestConfigTabs 一致） */
function formatMarkup(source: string): string {
  const lines = source
    .replace(/>\s+</g, "><")
    .trim()
    .replace(/></g, ">\n<")
    .split("\n");
  let indent = 0;
  return lines
    .map((line) => {
      const isClosing = /^<\//.test(line);
      const isSelfContained =
        /\/>$/.test(line) || /^<[!?]/.test(line) || /<\/[^>]+>$/.test(line);
      if (isClosing) indent = Math.max(indent - 1, 0);
      const out = "  ".repeat(indent) + line;
      if (!isClosing && !isSelfContained && /^</.test(line)) indent += 1;
      return out;
    })
    .join("\n");
}

/**
 * 将源文本按目标格式美化（失败时原样返回，不抛错）。
 * Hex / Base64 / Raw 不做美化，由调用方自行处理。
 */
export function prettyPrint(
  text: string,
  format: ResponseFormat,
): string {
  if (!text) return "";
  try {
    switch (format) {
      case "json":
        return JSON.stringify(JSON.parse(text), null, 2);
      case "xml":
      case "html":
        return formatMarkup(text);
      case "yaml": {
        // 先尝试当 JSON 解析再转 YAML；否则当 YAML 解析后规范化输出
        try {
          return new YAML.Document(JSON.parse(text)).toString();
        } catch {
          return YAML.stringify(YAML.parse(text));
        }
      }
      case "javascript":
      case "markdown":
      case "raw":
      default:
        return text;
    }
  } catch {
    return text;
  }
}

/** 把文本转为经典 hex dump（偏移 | 十六进制字节 | ASCII） */
export function toHexDump(text: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const chunk = bytes.subarray(offset, offset + 16);
    const hexParts: string[] = [];
    const asciiParts: string[] = [];
    for (let i = 0; i < 16; i++) {
      if (i < chunk.length) {
        const b = chunk[i]!;
        hexParts.push(b.toString(16).padStart(2, "0"));
        asciiParts.push(b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".");
      } else {
        hexParts.push("  ");
        asciiParts.push(" ");
      }
      // 8 字节后插入额外空格，视觉分组
      if (i === 7) hexParts.push("");
    }
    lines.push(
      `${offset.toString(16).padStart(8, "0")}  ${hexParts.join(" ")}  |${asciiParts.join("")}|`,
    );
  }
  return lines.join("\n");
}

/** UTF-8 文本 → Base64 */
export function toBase64(text: string): string {
  // btoa 仅支持 Latin-1，用 TextEncoder + 手动转换兼容多字节字符
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Hex dump 语言模式：基于 StreamLanguage 的简单词法（偏移/十六进制/ASCII） */
const hexHighlight = StreamLanguage.define<{
  state: number;
}>({
  name: "hexdump",
  token(stream) {
    if (stream.eatSpace()) return null;
    // 行首 8 位十六进制偏移
    if (stream.match(/^[0-9a-f]{8}\b/i)) return "lineNumber";
    // |...| 之间的 ASCII 区
    if (stream.match(/^\|[^|]*\|/)) return "string";
    // 十六进制字节对
    if (stream.match(/^[0-9a-f]{2}\b/i)) return "number";
    // 跳过其他字符
    stream.next();
    return null;
  },
  startState: () => ({ state: 0 }),
  copyState: (s) => ({ state: s.state }),
});

/**
 * 为指定格式返回 CodeMirror 语言扩展。
 * 不需要语法高亮的格式（raw / base64）返回空数组。
 */
export function getLanguageExtension(format: ResponseFormat): Extension[] {
  switch (format) {
    case "json":
      return [jsonLang()];
    case "xml":
      return [xmlLang()];
    case "html":
      return [htmlLang()];
    case "yaml":
      return [yamlLang()];
    case "javascript":
      return [jsLang()];
    case "markdown":
      return [mdLang()];
    case "hex":
      return [hexHighlight];
    default:
      return [];
  }
}
