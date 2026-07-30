import { GlobalOutlined, SaveOutlined } from "@ant-design/icons";
import { App, Button, Input } from "antd";
import { environmentsApi } from "../../api";
import { useTabSaveHandler } from "../../lib/save-shortcut";
import { useAppStore } from "../../stores/app";
import {
  isTabDirty,
  useTabsStore,
  type EnvironmentTab,
} from "../../stores/tabs";
import KeyValueEditor from "../common/KeyValueEditor";

interface Props {
  tab: EnvironmentTab;
}

/** Environment 详情页：第一行标题，下方为变量表格（Variable / Value / Description） */
export default function EnvironmentEditor({ tab }: Props) {
  const { message } = App.useApp();
  const refreshEnvironments = useAppStore((s) => s.refreshEnvironments);
  const { updateEnvironment, markEnvironmentSaved, setSaving } = useTabsStore();
  const dirty = isTabDirty(tab);

  const handleSave = async () => {
    setSaving(tab.key, true);
    try {
      await environmentsApi.update(tab.environmentId, {
        name: tab.name.trim() || "New Environment",
        variables: tab.variables.filter((v) => v.key.trim() !== ""),
      });
      await refreshEnvironments();
      markEnvironmentSaved(tab.key);
      message.success("已保存");
    } finally {
      setSaving(tab.key, false);
    }
  };

  // Cmd/Ctrl+S 触发保存；与 Save 按钮同样的禁用条件
  useTabSaveHandler(tab.key, () => {
    if (tab.saving || !dirty) return;
    void handleSave();
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 第一行：环境标题（可直接编辑）+ Save */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 4px 4px",
          minWidth: 0,
        }}
      >
        <GlobalOutlined style={{ fontSize: 16, color: "#8c8c8c", flexShrink: 0 }} />
        <Input
          value={tab.name}
          variant="borderless"
          maxLength={64}
          onChange={(e) => updateEnvironment(tab.key, { name: e.target.value })}
          style={{ fontSize: 15, fontWeight: 600, flex: 1, minWidth: 0, padding: 0 }}
        />
        <Button
          size="small"
          icon={<SaveOutlined />}
          loading={tab.saving}
          disabled={!dirty}
          onClick={() => void handleSave()}
        >
          Save
        </Button>
      </div>

      {/* 变量表格：草稿行 Variable 列 placeholder 为 Add Variable，Value 列无 placeholder */}
      <div
        className="slim-scroll"
        style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "4px 4px 8px" }}
      >
        <KeyValueEditor
          items={tab.variables}
          onChange={(variables) => updateEnvironment(tab.key, { variables })}
          keyTitle="Variable"
          valueTitle="Value"
          keyPlaceholder=""
          valuePlaceholder=""
          draftKeyPlaceholder="Add Variable"
          showDescription
        />
      </div>
    </div>
  );
}
