import { Input } from "antd";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, UIEvent } from "react";
import { useEnvVars } from "./use-env-vars";
import { renderVarSegments, useVarHover, VarTooltip } from "./var-overlay";
import { parseSegments } from "./var-segments";

interface LayerMetrics {
  font: CSSProperties;
  pad: CSSProperties;
  /** 层相对外层 wrapper 的定位（= textarea 在 wrapper 中的偏移 + 边框宽） */
  pos: CSSProperties;
  /** textarea 原背景色：转移到高亮层，textarea 自身透明 */
  bg?: string;
  radius?: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoSize?: boolean | { minRows?: number; maxRows?: number };
  className?: string;
  style?: CSSProperties;
}

/**
 * 带 {{var}} 变量高亮的多行输入框（antd Input.TextArea 替身，overlay 实现）：
 * - 命中当前环境变量 → 胡萝卜橙；未命中 → 红色；hover 显示变量值 tooltip
 * - 高亮层以相同字体 + pre-wrap 保证与 textarea 换行逐字对齐，双向滚动同步
 *
 * 实现同 VarInput：textarea 文字透明（保留光标），下层高亮层渲染彩色文本，
 * 另有不可见测量层做逐片段 hover 命中检测（多行需同时比对 X/Y）。
 */
export default function VarTextArea({
  value,
  onChange,
  placeholder,
  autoSize,
  className,
  style,
}: Props) {
  const envVars = useEnvVars();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<LayerMetrics | null>(null);
  /** IME 组合输入期间显示原文字色，避免组合中的文字不可见 */
  const [composing, setComposing] = useState(false);
  const { hover, handleMouseMove, clearHover } = useVarHover(mirrorRef, envVars, true);

  const segments = useMemo(() => parseSegments(value), [value]);

  // 从真实 textarea 元素提取字体 / 内边距 / 定位 / 背景，保证各层像素级重合
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const ta = wrapper?.querySelector("textarea");
    if (!wrapper || !ta) return;
    // 背景 / 边框可能在 textarea 自身（无 affix）或 affix 包裹层（allowClear / showCount）
    const boxEl = (ta.closest(".ant-input-affix-wrapper") as HTMLElement | null) ?? ta;
    // 临时移除内联透明背景，读取 variant 原有背景，读毕还原（布局阶段内完成，无闪烁）
    // antd 输入框带 transition: all——先禁用过渡，否则清除内联样式后会从透明渐变，立即读到的是过渡起始值
    const savedBg = boxEl.style.background;
    const savedTransition = boxEl.style.transition;
    boxEl.style.transition = "none";
    boxEl.style.background = "";
    const boxCs = getComputedStyle(boxEl);
    const rawBg = boxCs.backgroundColor;
    const bg = rawBg && rawBg !== "transparent" && rawBg !== "rgba(0, 0, 0, 0)" ? rawBg : undefined;
    const radius = boxCs.borderRadius;
    boxEl.style.background = savedBg;
    boxEl.style.transition = savedTransition;

    const cs = getComputedStyle(ta);
    const wrapperRect = wrapper.getBoundingClientRect();
    const boxRect = boxEl.getBoundingClientRect();
    const taRect = ta.getBoundingClientRect();
    // textarea 自身边框（affix 内部为 0，独立为 1px）
    const iTop = parseFloat(cs.borderTopWidth || "0");
    const iLeft = parseFloat(cs.borderLeftWidth || "0");
    const iRight = parseFloat(cs.borderRightWidth || "0");
    const iBottom = parseFloat(cs.borderBottomWidth || "0");
    setMetrics({
      font: {
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
      },
      // 高亮层覆盖 box 边框盒（背景填满至圆角）；内边距 = box 边框盒 → textarea 文字起点
      pad: {
        paddingLeft:
          taRect.left + iLeft - boxRect.left + parseFloat(cs.paddingLeft || "0"),
        paddingRight:
          boxRect.right - (taRect.right - iRight) + parseFloat(cs.paddingRight || "0"),
        paddingTop:
          taRect.top + iTop - boxRect.top + parseFloat(cs.paddingTop || "0"),
        paddingBottom:
          boxRect.bottom - (taRect.bottom - iBottom) + parseFloat(cs.paddingBottom || "0"),
      },
      pos: {
        top: boxRect.top - wrapperRect.top,
        left: boxRect.left - wrapperRect.left,
        right: wrapperRect.right - boxRect.right,
        bottom: wrapperRect.bottom - boxRect.bottom,
      },
      bg,
      radius,
    });
  }, []);

  /** 双向滚动同步：高亮层用 translate，测量层用 scrollLeft/Top（其 span rect 自动计入偏移） */
  const handleScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (backdropRef.current) {
      backdropRef.current.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`;
    }
    if (mirrorRef.current) {
      mirrorRef.current.scrollLeft = el.scrollLeft;
      mirrorRef.current.scrollTop = el.scrollTop;
    }
  };

  /** 与 textarea 换行行为一致：pre-wrap + 长词断行；末尾补 \n 对齐 textarea 末行行盒 */
  const wrapStyle: CSSProperties = { whiteSpace: "pre-wrap", overflowWrap: "break-word" };

  return (
    <div
      ref={wrapperRef}
      style={{ position: "relative", ...style }}
      onMouseMove={handleMouseMove}
      onMouseLeave={clearHover}
    >
      {metrics && (
        <>
          {/* 高亮层：彩色渲染 {{var}}，随 textarea 双向滚动 */}
          <div
            style={{
              position: "absolute",
              overflow: "hidden",
              pointerEvents: "none",
              background: metrics.bg,
              borderRadius: metrics.radius,
              ...metrics.pos,
            }}
          >
            <div ref={backdropRef} style={{ ...wrapStyle, ...metrics.font, ...metrics.pad }}>
              {renderVarSegments(segments, envVars, true)}
              {"\n"}
            </div>
          </div>
          {/* 测量层：与 textarea 重合但不可见，仅用于 hover 逐片段命中检测 */}
          <div
            ref={mirrorRef}
            aria-hidden
            style={{
              position: "absolute",
              overflow: "hidden",
              visibility: "hidden",
              pointerEvents: "none",
              ...wrapStyle,
              ...metrics.pos,
              ...metrics.font,
              ...metrics.pad,
            }}
          >
            {renderVarSegments(segments, envVars, false)}
            {"\n"}
          </div>
        </>
      )}

      <Input.TextArea
        className={className}
        autoSize={autoSize}
        placeholder={placeholder}
        value={value}
        style={{
          position: "relative",
          background: "transparent",
          color: composing ? "rgba(0, 0, 0, 0.85)" : "transparent",
          caretColor: "rgba(0, 0, 0, 0.85)",
        }}
        onChange={(e) => {
          clearHover();
          onChange(e.target.value);
        }}
        onScroll={handleScroll}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />

      <VarTooltip hover={hover} />
    </div>
  );
}
