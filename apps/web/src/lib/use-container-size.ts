import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 监听容器尺寸，供虚拟滚动列表（react-arborist）使用。
 * 侧栏面板折叠时为 display:none，容器高度为 0；而 ResizeObserver 的回调依赖渲染帧，
 * 后台页签不触发，因此不能只靠观察器恢复尺寸。调用方传入 visible，在可见性切换时同步补量一次。
 */
export function useContainerSize(visible = true) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setSize((prev) =>
      prev.width === el.clientWidth && prev.height === el.clientHeight
        ? prev
        : { width: el.clientWidth, height: el.clientHeight },
    );
  }, []);

  // 可见性切换后（含首次挂载）同步测量，不依赖观察器回调
  useLayoutEffect(() => {
    if (visible) measure();
  }, [visible, measure]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  return { ref, size };
}
