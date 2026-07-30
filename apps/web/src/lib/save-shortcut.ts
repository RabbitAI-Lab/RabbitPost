import { useEffect, useRef } from "react";
import { useTabsStore } from "../stores/tabs";

/** 各 tab 编辑器注册的 Save 处理器（key = tab.key） */
const saveHandlers = new Map<string, () => void>();

/** 编辑器挂载期间注册当前 tab 的保存处理器，供 Cmd/Ctrl+S 全局快捷键调用 */
export function useTabSaveHandler(key: string, handler: () => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    saveHandlers.set(key, () => handlerRef.current());
    return () => {
      saveHandlers.delete(key);
    };
  }, [key]);
}

/** 全局拦截 Cmd/Ctrl+S：阻止浏览器保存网页，转为触发当前激活 tab 的 Save */
export function useGlobalSaveShortcut() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "s"
      ) {
        e.preventDefault();
        const { activeKey } = useTabsStore.getState();
        if (activeKey) saveHandlers.get(activeKey)?.();
      }
    };
    // capture 阶段监听，保证输入框 / 代码编辑器聚焦时也能拦截
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
