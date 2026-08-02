import { Button, Modal, Space } from "antd";
import { createElement, useEffect, useRef } from "react";
import { isTabDirty, useTabsStore } from "../stores/tabs";

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

/** 全局拦截 Cmd/Ctrl+Alt+W：关闭当前激活的工作 tab（Cmd+W 被浏览器保留，无法拦截） */
export function useGlobalCloseTabShortcut() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "w"
      ) {
        e.preventDefault();
        const { activeKey } = useTabsStore.getState();
        if (activeKey) confirmCloseTab(activeKey);
      }
    };
    // capture 阶段监听，保证输入框 / 代码编辑器聚焦时也能拦截
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}

/** 关闭 tab：有未保存修改时弹二次确认（保存并关闭 / 直接关闭 / 取消），无修改直接关闭 */
export function confirmCloseTab(key: string) {
  const { tabs, closeTab } = useTabsStore.getState();
  const tab = tabs.find((t) => t.key === key);
  if (!tab) return;
  if (!isTabDirty(tab)) {
    closeTab(key);
    return;
  }

  /** 触发该 tab 的保存，保存成功（dirty 清除）后再关闭；用户取消保存则不关闭 */
  const saveAndClose = () => {
    const save = saveHandlers.get(key);
    if (!save) return;
    // 订阅 store：等该 tab 被 markSaved（不再是 dirty）后关闭并退订
    const unsub = useTabsStore.subscribe((s) => {
      const t = s.tabs.find((x) => x.key === key);
      // tab 已被别处关闭，或保存完成：退订并关闭弹窗/tab
      if (!t) {
        unsub();
        return;
      }
      if (!isTabDirty(t)) {
        unsub();
        useTabsStore.getState().closeTab(key);
      }
    });
    save();
  };

  const modal = Modal.confirm({
    title: "关闭标签页",
    content: `「${tab.name}」有未保存的修改，关闭后将丢失。`,
    // 三按钮：取消 / 直接关闭 / 保存并关闭（用 createElement 避免本文件改为 .tsx）
    footer: createElement(
      Space,
      { style: { display: "flex", justifyContent: "flex-end" } },
      createElement(Button, { onClick: () => modal.destroy() }, "取消"),
      createElement(
        Button,
        {
          danger: true,
          onClick: () => {
            modal.destroy();
            closeTab(key);
          },
        },
        "直接关闭",
      ),
      createElement(
        Button,
        {
          type: "primary",
          onClick: () => {
            modal.destroy();
            saveAndClose();
          },
        },
        "保存并关闭",
      ),
    ),
  });
}
