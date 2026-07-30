import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, UIEvent } from "react";
import { Input } from "antd";
import { useAppStore } from "../../stores/app";

/** {{varName}} 变量匹配（与 shared 包 substituteVariables 规则一致） */
const VAR_RE = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** 胡萝卜橙：变量已在当前环境中解析 */
const COLOR_RESOLVED = "#ff6c37";
/** 红色：变量未找到 */
const COLOR_UNRESOLVED = "#ff4d4f";

interface Segment {
  text: string;
  varName?: string;
}

interface LayerMetrics {
  /** 字体相关（高亮层 / 测量层与 input 文字对齐） */
  font: CSSProperties;
  /** 内边距（与 input 内容区起点一致） */
  pad: CSSProperties;
  /** 层相对外层 wrapper 的定位（= input 在 wrapper 中的偏移 + 边框宽） */
  pos: CSSProperties;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  placeholder?: string;
  style?: CSSProperties;
}

/** 把 URL 拆分为普通文本与 {{var}} 变量片段 */
function parseSegments(url: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const m of url.matchAll(VAR_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) segments.push({ text: url.slice(last, idx) });
    segments.push({ text: m[0], varName: m[1] });
    last = idx + m[0].length;
  }
  if (last < url.length) segments.push({ text: url.slice(last) });
  return segments;
}

/**
 * 带变量高亮的 URL 输入框（对齐 Postman）：
 * - {{var}} 命中当前环境变量 → 胡萝卜橙；未命中 → 红色
 * - 鼠标悬浮变量片段时显示其当前值的 tooltip
 *
 * 实现（overlay）：input 文字透明（保留光标），下层高亮层以相同字体渲染彩色文本；
 * 另有一个与 input 完全重合的不可见测量层，用于逐片段命中检测。
 */
export default function UrlInput({ value, onChange, onEnter, placeholder, style }: Props) {
  const environments = useAppStore((s) => s.environments);
  const activeEnvironmentId = useAppStore((s) => s.activeEnvironmentId);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<LayerMetrics | null>(null);
  const [hover, setHover] = useState<{ value: string; resolved: boolean } | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  /** IME 组合输入期间显示原文字色，避免组合中的文字不可见 */
  const [composing, setComposing] = useState(false);

  /** 当前环境变量表（仅启用条目） */
  const envVars = useMemo(() => {
    const env = environments.find((e) => e.id === activeEnvironmentId);
    const map: Record<string, { value: string; secret?: boolean }> = {};
    for (const v of env?.variables ?? []) {
      if (v.enabled && v.key) map[v.key] = { value: v.value, secret: v.secret };
    }
    return map;
  }, [environments, activeEnvironmentId]);

  const segments = useMemo(() => parseSegments(value), [value]);

  // 从真实 input 元素提取字体 / 内边距 / 定位，保证高亮层、测量层与 input 文字像素级重合
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const input = wrapper?.querySelector("input");
    if (!wrapper || !input) return;
    const cs = getComputedStyle(input);
    const wrapperRect = wrapper.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    setMetrics({
      font: {
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
      },
      pad: {
        paddingLeft: cs.paddingLeft,
        paddingRight: cs.paddingRight,
        paddingTop: cs.paddingTop,
        paddingBottom: cs.paddingBottom,
      },
      pos: {
        top: inputRect.top - wrapperRect.top + parseFloat(cs.borderTopWidth || "0"),
        left: inputRect.left - wrapperRect.left + parseFloat(cs.borderLeftWidth || "0"),
        right: wrapperRect.right - inputRect.right + parseFloat(cs.borderRightWidth || "0"),
        bottom: wrapperRect.bottom - inputRect.bottom + parseFloat(cs.borderBottomWidth || "0"),
      },
    });
  }, []);

  /** 横向滚动同步：高亮层用 translateX，测量层用 scrollLeft（其 span rect 自动计入偏移） */
  const handleScroll = (e: UIEvent<HTMLInputElement>) => {
    const sl = e.currentTarget.scrollLeft;
    if (backdropRef.current) backdropRef.current.style.transform = `translateX(${-sl}px)`;
    if (mirrorRef.current) mirrorRef.current.scrollLeft = sl;
  };

  /** 逐片段命中检测：测量层与 input 文字完全重合，直接比对 span 的视口矩形 */
  const handleMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    const mirror = mirrorRef.current;
    if (!mirror) return;
    let found = false;
    for (const span of mirror.querySelectorAll<HTMLElement>("[data-var]")) {
      const r = span.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right) {
        const info = envVars[span.dataset.var!];
        setHover({
          value: info ? (info.secret ? "••••••••" : info.value || "(空)") : "",
          resolved: !!info,
        });
        setTooltipPos({ x: r.left + r.width / 2, y: r.top });
        found = true;
        break;
      }
    }
    if (!found) setHover((h) => (h ? null : h));
  };

  const renderSegments = (withColor: boolean) =>
    segments.map((seg, i) => (
      <span
        key={i}
        data-var={seg.varName}
        style={
          withColor && seg.varName
            ? { color: envVars[seg.varName] ? COLOR_RESOLVED : COLOR_UNRESOLVED }
            : undefined
        }
      >
        {seg.text}
      </span>
    ));

  return (
    <div
      ref={wrapperRef}
      style={{ position: "relative", ...style }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHover(null)}
    >
      {metrics && (
        <>
          {/* 高亮层：彩色渲染 {{var}}，随 input 横向滚动 */}
          <div
            style={{
              position: "absolute",
              overflow: "hidden",
              pointerEvents: "none",
              ...metrics.pos,
            }}
          >
            <div ref={backdropRef} style={{ whiteSpace: "pre", ...metrics.font, ...metrics.pad }}>
              {renderSegments(true)}
            </div>
          </div>
          {/* 测量层：与 input 重合但不可见，仅用于 hover 逐片段命中检测 */}
          <div
            ref={mirrorRef}
            aria-hidden
            style={{
              position: "absolute",
              overflow: "hidden",
              whiteSpace: "pre",
              visibility: "hidden",
              pointerEvents: "none",
              ...metrics.pos,
              ...metrics.font,
              ...metrics.pad,
            }}
          >
            {renderSegments(false)}
          </div>
        </>
      )}

      <Input
        className="code-font"
        style={{
          position: "relative",
          background: "transparent",
          color: composing ? "rgba(0, 0, 0, 0.85)" : "transparent",
          caretColor: "rgba(0, 0, 0, 0.85)",
        }}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          setHover(null);
          onChange(e.target.value);
        }}
        onPressEnter={onEnter}
        onScroll={handleScroll}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />

      {/* 变量值 tooltip（fixed 定位跟随悬浮片段，不受祖先 overflow 裁剪） */}
      {hover && (
        <div
          style={{
            position: "fixed",
            left: tooltipPos.x,
            top: tooltipPos.y - 6,
            transform: "translate(-50%, -100%)",
            background: "rgba(0, 0, 0, 0.85)",
            color: "#fff",
            padding: "5px 10px",
            borderRadius: 6,
            fontSize: 12,
            lineHeight: "18px",
            whiteSpace: "nowrap",
            pointerEvents: "none",
            zIndex: 1070,
            boxShadow: "0 6px 16px 0 rgba(0, 0, 0, 0.12)",
          }}
        >
          {hover.resolved ? (
            hover.value
          ) : (
            <span style={{ color: "#ff7875" }}>未找到变量</span>
          )}
        </div>
      )}
    </div>
  );
}
