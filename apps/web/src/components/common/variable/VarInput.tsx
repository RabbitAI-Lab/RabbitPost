import { Input } from "antd";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, UIEvent } from "react";
import { useEnvVars } from "./use-env-vars";
import { renderVarSegments, useVarHover, VarTooltip } from "./var-overlay";
import { parseSegments } from "./var-segments";

interface LayerMetrics {
  /** 字体相关（高亮层 / 测量层与 input 文字对齐） */
  font: CSSProperties;
  /** 内边距（与 input 内容区起点一致） */
  pad: CSSProperties;
  /** 层相对外层 wrapper 的定位（= input 在 wrapper 中的偏移 + 边框宽） */
  pos: CSSProperties;
  /** input 原背景色（filled 变体为灰底）：转移到高亮层，input 自身透明 */
  bg?: string;
  radius?: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  placeholder?: string;
  size?: "small" | "middle" | "large";
  variant?: "outlined" | "borderless" | "filled";
  className?: string;
  style?: CSSProperties;
  suffix?: ReactNode;
  /** 禁用时不渲染变量高亮层，直接用 antd 原生禁用样式 */
  disabled?: boolean;
}

/**
 * 带 {{var}} 变量高亮的单行输入框（antd Input 替身，overlay 实现）：
 * - 命中当前环境变量 → 胡萝卜橙；未命中 → 红色；hover 显示变量值 tooltip
 * - 保持 antd 原生外观（size / variant / suffix），背景转移到高亮层
 *
 * 实现：input 文字透明（保留光标），下层高亮层以相同字体渲染彩色文本；
 * 另有一个与 input 完全重合的不可见测量层，用于逐片段 hover 命中检测。
 */
export default function VarInput({
  value,
  onChange,
  onEnter,
  placeholder,
  size,
  variant,
  className,
  style,
  suffix,
  disabled,
}: Props) {
  const envVars = useEnvVars();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<LayerMetrics | null>(null);
  /** IME 组合输入期间显示原文字色，避免组合中的文字不可见 */
  const [composing, setComposing] = useState(false);
  const { hover, handleMouseMove, clearHover } = useVarHover(mirrorRef, envVars);

  const segments = useMemo(() => parseSegments(value), [value]);

  // 从真实 input 元素提取字体 / 内边距 / 定位 / 背景，保证高亮层、测量层与 input 文字像素级重合
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const input = wrapper?.querySelector("input");
    if (!wrapper || !input) return;
    // 背景 / 边框可能在 input 自身（无 affix）或 affix 包裹层（带 suffix）
    const boxEl = (input.closest(".ant-input-affix-wrapper") as HTMLElement | null) ?? input;
    // 临时移除内联透明背景，读取 variant 原有背景（filled 为灰底），读毕还原（布局阶段内完成，无闪烁）
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

    const cs = getComputedStyle(input);
    const wrapperRect = wrapper.getBoundingClientRect();
    const boxRect = boxEl.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    // input 自身边框（affix 内部 input 为 0，独立 input 为 1px）
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
      // 高亮层覆盖 box 边框盒（背景填满至圆角）；内边距 = box 边框盒 → input 文字起点
      pad: {
        paddingLeft:
          inputRect.left + iLeft - boxRect.left + parseFloat(cs.paddingLeft || "0"),
        paddingRight:
          boxRect.right - (inputRect.right - iRight) + parseFloat(cs.paddingRight || "0"),
        paddingTop:
          inputRect.top + iTop - boxRect.top + parseFloat(cs.paddingTop || "0"),
        paddingBottom:
          boxRect.bottom - (inputRect.bottom - iBottom) + parseFloat(cs.paddingBottom || "0"),
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

  /** 横向滚动同步：高亮层用 translateX，测量层用 scrollLeft（其 span rect 自动计入偏移） */
  const handleScroll = (e: UIEvent<HTMLInputElement>) => {
    const sl = e.currentTarget.scrollLeft;
    if (backdropRef.current) backdropRef.current.style.transform = `translateX(${-sl}px)`;
    if (mirrorRef.current) mirrorRef.current.scrollLeft = sl;
  };

  return (
    <div
      ref={wrapperRef}
      style={{ position: "relative", ...style }}
      onMouseMove={handleMouseMove}
      onMouseLeave={clearHover}
    >
      {metrics && !disabled && (
        <>
          {/* 高亮层：彩色渲染 {{var}}，随 input 横向滚动 */}
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
            <div ref={backdropRef} style={{ whiteSpace: "pre", ...metrics.font, ...metrics.pad }}>
              {renderVarSegments(segments, envVars, true)}
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
            {renderVarSegments(segments, envVars, false)}
          </div>
        </>
      )}

      <Input
        className={className}
        size={size}
        variant={variant}
        suffix={suffix}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        style={{
          position: "relative",
          background: "transparent",
          color: disabled
            ? undefined
            : composing
              ? "rgba(0, 0, 0, 0.85)"
              : "transparent",
          caretColor: "rgba(0, 0, 0, 0.85)",
        }}
        onChange={(e) => {
          clearHover();
          onChange(e.target.value);
        }}
        onPressEnter={onEnter}
        onScroll={handleScroll}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />

      <VarTooltip hover={hover} />
    </div>
  );
}
