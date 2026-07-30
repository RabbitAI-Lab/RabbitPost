import { DownOutlined, SaveOutlined, SendOutlined } from "@ant-design/icons";
import {
  App,
  Button,
  Dropdown,
  Input,
  Modal,
  Select,
  Space,
  Splitter,
} from "antd";
import { useState } from "react";
import { HTTP_METHODS, resolveRequestSettings, substituteVariables } from "@rabbitpost/shared";
import { collectionsApi, executeApi } from "../../api";
import { useTabSaveHandler } from "../../lib/save-shortcut";
import { useAppStore } from "../../stores/app";
import {
  cookieHeaderForUrl,
  hostnameOf,
  useCookiesStore,
} from "../../stores/cookies";
import { isTabDirty, useTabsStore, type RequestTab } from "../../stores/tabs";
import { newKvItem } from "../common/KeyValueEditor";
import RequestConfigTabs from "./RequestConfigTabs";
import RequestTitleBar from "./RequestTitleBar";
import ResponseViewer from "./ResponseViewer";
import UrlInput from "./UrlInput";

interface Props {
  tab: RequestTab;
}

export default function RequestEditor({ tab }: Props) {
  const { message } = App.useApp();
  const {
    currentWorkspaceId,
    activeEnvironmentId,
    environments,
    collections,
    refreshCollectionTree,
  } = useAppStore();
  const { updateConfig, setSending, setSaving, setResponse, markSaved, renameTab } =
    useTabsStore();
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  /** 弹窗模式：save = 保存草稿；saveAs = 另存为新数据（原数据不动） */
  const [saveAsMode, setSaveAsMode] = useState(false);
  const [saveName, setSaveName] = useState(tab.name);
  const [saveCollectionId, setSaveCollectionId] = useState<string | null>(
    tab.collectionId,
  );

  const patch = updateConfig;
  const dirty = isTabDirty(tab);

  const handleSend = async () => {
    if (!currentWorkspaceId) {
      message.warning("请先选择 Workspace");
      return;
    }
    if (!tab.config.url.trim()) {
      message.warning("请输入请求 URL");
      return;
    }
    setSending(tab.key, true);
    try {
      // 用当前环境变量解析 URL，从 Cookie Jar 取匹配的 Cookie 随请求发送（同 Postman）
      const settings = resolveRequestSettings(tab.config.settings);
      const env = environments.find((e) => e.id === activeEnvironmentId);
      const vars = Object.fromEntries(
        (env?.variables ?? [])
          .filter((v) => v.enabled && v.key)
          .map((v) => [v.key, v.value]),
      );
      const resolvedUrl = substituteVariables(tab.config.url, vars);
      // Disable cookie jar：本请求不带上已存 cookie
      const jarCookie = settings.disableCookieJar
        ? ""
        : cookieHeaderForUrl(resolvedUrl, useCookiesStore.getState().domains);
      let request = tab.config;
      if (jarCookie) {
        const userCookie = tab.config.headers.find(
          (h) => h.enabled && h.key.toLowerCase() === "cookie",
        );
        // 用户已手写 Cookie 头时合并到同一个头，避免重复 Cookie 头
        request = userCookie
          ? {
              ...tab.config,
              headers: tab.config.headers.map((h) =>
                h.id === userCookie.id
                  ? { ...h, value: h.value ? `${h.value}; ${jarCookie}` : jarCookie }
                  : h,
              ),
            }
          : {
              ...tab.config,
              headers: [
                ...tab.config.headers,
                newKvItem({ key: "Cookie", value: jarCookie }),
              ],
            };
      }
      const result = await executeApi.run({
        workspaceId: currentWorkspaceId,
        environmentId: activeEnvironmentId,
        name: tab.name,
        request,
      });
      setResponse(tab.key, result);
      // 响应的 Set-Cookie 自动写回 Cookie Jar（同 Postman）；Disable cookie jar 时不写回
      const host = hostnameOf(resolvedUrl);
      if (!settings.disableCookieJar && host && result.cookies?.length) {
        useCookiesStore.getState().storeResponseCookies(host, result.cookies);
      }
      // 通知 History 面板刷新
      window.dispatchEvent(new CustomEvent("rabbitpost:history-updated"));
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(tab.key, false);
    }
  };

  const handleSave = async () => {
    if (tab.itemId) {
      // 已有关联 item：直接更新
      setSaving(tab.key, true);
      try {
        await collectionsApi.updateItem(tab.itemId, {
          request: tab.config,
        });
        if (tab.collectionId) await refreshCollectionTree(tab.collectionId);
        markSaved(tab.key, tab.itemId, tab.collectionId!, tab.name);
        message.success("已保存");
      } finally {
        setSaving(tab.key, false);
      }
    } else {
      // 草稿：选择 collection 后创建
      setSaveAsMode(false);
      setSaveName(tab.name);
      setSaveCollectionId(tab.collectionId ?? collections[0]?.id ?? null);
      setSaveModalOpen(true);
    }
  };

  // Cmd/Ctrl+S 触发保存；与 Save 按钮同样的禁用条件（保存中 / 已关联且无修改时忽略）
  useTabSaveHandler(tab.key, () => {
    if (tab.saving || saveModalOpen) return;
    if (!dirty && tab.itemId) return;
    void handleSave();
  });

  /** 另存为：将当前修改保存为新条目，原条目保持不变，tab 改为关联新条目 */
  const handleSaveAs = () => {
    setSaveAsMode(true);
    setSaveName(tab.itemId ? `${tab.name} Copy` : tab.name);
    setSaveCollectionId(tab.collectionId ?? collections[0]?.id ?? null);
    setSaveModalOpen(true);
  };

  const handleSaveModalOk = async () => {
    if (!saveCollectionId) {
      message.warning("请选择 Collection");
      return;
    }
    setSaving(tab.key, true);
    try {
      const item = await collectionsApi.createItem(saveCollectionId, {
        type: "request",
        name: saveName.trim() || "New Request",
      });
      await collectionsApi.updateItem(item.id, { request: tab.config });
      await refreshCollectionTree(saveCollectionId);
      markSaved(tab.key, item.id, saveCollectionId, saveName.trim() || "New Request");
      renameTab(tab.key, saveName.trim() || "New Request");
      setSaveModalOpen(false);
      message.success(saveAsMode ? "已另存为新请求" : "已保存到 Collection");
    } finally {
      setSaving(tab.key, false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 协议类型 + 目录路径 > 标题 + Save/Save As */}
      <RequestTitleBar
        tab={tab}
        extra={
          <Space.Compact>
            <Button
              size="small"
              icon={<SaveOutlined />}
              loading={tab.saving}
              disabled={!dirty && !!tab.itemId}
              onClick={() => void handleSave()}
            >
              Save
            </Button>
            <Dropdown
              menu={{
                items: [{ key: "saveAs", label: "Save As..." }],
                onClick: ({ key }) => {
                  if (key === "saveAs") handleSaveAs();
                },
              }}
              trigger={["click"]}
            >
              <Button size="small" icon={<DownOutlined />} />
            </Dropdown>
          </Space.Compact>
        }
      />

      {/* 方法 + URL + 发送：各自独立分开，保留四个圆角 */}
      <div style={{ display: "flex", gap: 8, width: "100%", marginBottom: 8 }}>
        <Select
          value={tab.config.method}
          style={{ width: 110, flexShrink: 0 }}
          options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
          onChange={(method) => patch(tab.key, { method })}
        />
        <UrlInput
          style={{ flex: 1, minWidth: 0 }}
          placeholder="https://api.example.com/users/{{userId}}"
          value={tab.config.url}
          onChange={(url) => patch(tab.key, { url })}
          onEnter={() => void handleSend()}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          loading={tab.sending}
          style={{ flexShrink: 0 }}
          onClick={() => void handleSend()}
        >
          Send
        </Button>
      </div>

      {/* 请求 / 响应分栏：拖拽分割线调整两区高度 */}
      <Splitter layout="vertical" style={{ flex: 1, minHeight: 0 }}>
        <Splitter.Panel defaultSize="55%" min="15%" style={{ paddingBottom: 4 }}>
          <RequestConfigTabs tab={tab} />
        </Splitter.Panel>
        <Splitter.Panel min="15%" style={{ paddingTop: 4 }}>
          <ResponseViewer response={tab.response} sending={tab.sending} />
        </Splitter.Panel>
      </Splitter>

      {/* 保存草稿 / 另存为新条目 */}
      <Modal
        title={saveAsMode ? "另存为" : "保存请求"}
        open={saveModalOpen}
        onOk={() => void handleSaveModalOk()}
        onCancel={() => setSaveModalOpen(false)}
        okText="保存"
        cancelText="取消"
        confirmLoading={tab.saving}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Input
            placeholder="请求名称"
            value={saveName}
            maxLength={256}
            onChange={(e) => setSaveName(e.target.value)}
          />
          <Select
            style={{ width: "100%" }}
            placeholder="选择 Collection"
            value={saveCollectionId}
            onChange={setSaveCollectionId}
            options={collections.map((c) => ({ value: c.id, label: c.name }))}
          />
        </Space>
      </Modal>
    </div>
  );
}
