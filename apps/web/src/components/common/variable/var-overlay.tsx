import { useCallback, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { COLOR_RESOLVED, COLOR_UNRESOLVED, type EnvVarMap, type Segment } from "./var-segments";

/** 渲染片段列表；withColor 时变量片段按解析结果着色，data-var 供命中检测 */
export function renderVarSegments(
  segments: Segment[],
  envVars: EnvVarMap,
  withColor: boolean,
): ReactNode {
  return segments.map((seg, i) => (
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
}

export interface VarHover {
  /** tooltip 锚点（视口坐标） */
  x: number;
  y: number;
  value: string;
  resolved: boolean;
}

/**
 * 逐片段 hover 命中检测：测量层与输入控件文字完全重合，
 * 直接比对带 data-var 的 span 视口矩形。checkY 用于多行场景。
 */
export function useVarHover(
  mirrorRef: RefObject<HTMLDivElement | null>,
  envVars: EnvVarMap,
  checkY = false,
) {
  const [hover, setHover] = useState<VarHover | null>(null);

  const handleMouseMove = useCallback(
    (e: ReactMouseEvent<Element>) => {
      const mirror = mirrorRef.current;
      if (!mirror) return;
      let found = false;
      for (const span of mirror.querySelectorAll<HTMLElement>("[data-var]")) {
        const r = span.getBoundingClientRect();
        const hitX = e.clientX >= r.left && e.clientX <= r.right;
        const hitY = !checkY || (e.clientY >= r.top && e.clientY <= r.bottom);
        if (hitX && hitY) {
          const info = envVars[span.dataset.var!];
          setHover({
            x: r.left + r.width / 2,
            y: r.top,
            value: info ? (info.secret ? "••••••••" : info.value || "(空)") : "",
            resolved: !!info,
          });
          found = true;
          break;
        }
      }
      if (!found) setHover((h) => (h ? null : h));
    },
    [mirrorRef, envVars, checkY],
  );

  const clearHover = useCallback(() => setHover((h) => (h ? null : h)), []);

  return { hover, handleMouseMove, clearHover };
}

/** 变量值 tooltip：fixed 定位跟随悬浮片段，不受祖先 overflow 裁剪 */
export function VarTooltip({ hover }: { hover: VarHover | null }) {
  if (!hover) return null;
  return (
    <div
      style={{
        position: "fixed",
        left: hover.x,
        top: hover.y - 6,
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
  );
}
