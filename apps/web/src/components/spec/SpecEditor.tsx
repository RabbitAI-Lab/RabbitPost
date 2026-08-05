import {
  DeleteOutlined,
  DownloadOutlined,
  FileTextOutlined,
  FormatPainterOutlined,
  MoreOutlined,
  SaveOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { json as jsonLang } from "@codemirror/lang-json";
import { yaml as yamlLang } from "@codemirror/lang-yaml";
import { forceLinting, linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { App, Button, Dropdown, Input, Modal, Segmented, Splitter, Tag } from "antd";
import { useDeferredValue, useEffect, useMemo, useRef } from "react";
import type { SpecIssue } from "@rabbitpost/shared";
import {
  convertSpecFormat,
  SPEC_FORMAT_LABELS,
  SPEC_FORMATS,
  SPEC_TYPE_LABELS,
  validateSpec,
  type SpecFormat,
} from "@rabbitpost/shared";
import { specsApi } from "../../api";
import { useTabSaveHandler } from "../../lib/save-shortcut";
import { useAppStore } from "../../stores/app";
import { isTabDirty, useTabsStore, type SpecTab } from "../../stores/tabs";
import SpecDocsPreview from "./SpecDocsPreview";
import SpecIssuesPanel from "./SpecIssuesPanel";

interface Props {
  tab: SpecTab;
}

/** 校验结果 -> CodeMirror 诊断（错误行标记 + gutter 图标） */
function toDiagnostics(view: EditorView, issues: SpecIssue[]): Diagnostic[] {
  const doc = view.state.doc;
  return issues.map((issue) => {
    const line = doc.line(Math.min(Math.max(issue.line, 1), doc.lines));
    const from = Math.min(line.from + Math.max(issue.column - 1, 0), line.to);
    return {
      from,
      to: line.to,
      severity: issue.severity,
      message: `${issue.message}（${issue.rule}）`,
      source: "spec",
    };
  });
}

/**
 * Spec 详情页（对齐 Postman spec 编辑器）：
 * 顶部标题行（名称 / 类型 / 格式 / Save / Generate collection），
 * 下方左右分栏：左侧为定义编辑器 + 底部 Issues，右侧为实时文档预览。
 */
export default function SpecEditor({ tab }: Props) {
  const { message } = App.useApp();
  const refreshSpecs = useAppStore((s) => s.refreshSpecs);
  const refreshCollections = useAppStore((s) => s.refreshCollections);
  const { updateSpec, markSpecSaved, setSaving, closeTab } = useTabsStore();
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const dirty = isTabDirty(tab);

  // 校验跟随输入但不阻塞输入：用 deferred 值计算
  const deferredContent = useDeferredValue(tab.content);
  const issues = useMemo(
    () => validateSpec(deferredContent, tab.type),
    [deferredContent, tab.type],
  );
  const issuesRef = useRef(issues);
  issuesRef.current = issues;

  const extensions = useMemo(
    () => [
      tab.format === "json" ? jsonLang() : yamlLang(),
      lintGutter(),
      linter((view) => toDiagnostics(view, issuesRef.current), { delay: 150 }),
      EditorView.lineWrapping,
    ],
    [tab.format],
  );

  // 校验结果更新后立即刷新编辑器内的诊断标记
  useEffect(() => {
    const view = cmRef.current?.view;
    if (view) forceLinting(view);
  }, [issues]);

  const handleSave = async () => {
    setSaving(tab.key, true);
    try {
      await specsApi.update(tab.specId, {
        name: tab.name.trim() || "New Spec",
        format: tab.format,
        content: tab.content,
      });
      await refreshSpecs();
      markSpecSaved(tab.key);
      message.success("已保存");
    } finally {
      setSaving(tab.key, false);
    }
  };

  useTabSaveHandler(tab.key, () => {
    if (tab.saving || !dirty) return;
    void handleSave();
  });

  /** 生成 Collection：服务端读取已保存的定义，因此有未保存修改时先保存 */
  const handleGenerate = async (replaceLinked: boolean) => {
    if (dirty) await handleSave();
    const result = await specsApi.generateCollection(tab.specId, { replaceLinked });
    updateSpec(tab.key, { generatedCollectionId: result.collectionId });
    await Promise.all([refreshCollections(), refreshSpecs()]);
    message.success(
      `${result.reused ? "已更新" : "已生成"} Collection：${result.folderCount} 个文件夹、${result.requestCount} 个请求`,
    );
  };

  const handleFormatChange = (format: SpecFormat) => {
    if (format === tab.format) return;
    updateSpec(tab.key, { format, content: convertSpecFormat(tab.content, format) });
  };

  const handleDownload = () => {
    const blob = new Blob([tab.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${tab.name || "spec"}.${tab.format === "json" ? "json" : "yaml"}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleDelete = () => {
    Modal.confirm({
      title: "删除 Spec",
      content: `确定删除「${tab.name}」吗？由它生成的 Collection 不会被删除。`,
      okButtonProps: { danger: true },
      okText: "删除",
      cancelText: "取消",
      onOk: async () => {
        await specsApi.remove(tab.specId);
        closeTab(tab.key);
        await refreshSpecs();
        message.success("已删除");
      },
    });
  };

  const generateMenu = {
    items: [
      {
        key: "new",
        icon: <ThunderboltOutlined />,
        label: "生成新的 Collection",
        onClick: () => void handleGenerate(false),
      },
      {
        key: "replace",
        icon: <ThunderboltOutlined />,
        label: "更新已关联的 Collection",
        disabled: !tab.generatedCollectionId,
        onClick: () => void handleGenerate(true),
      },
    ],
  };

  const moreMenu = {
    items: [
      {
        key: "format",
        icon: <FormatPainterOutlined />,
        label: "格式化定义",
        onClick: () =>
          updateSpec(tab.key, { content: convertSpecFormat(tab.content, tab.format) }),
      },
      {
        key: "download",
        icon: <DownloadOutlined />,
        label: "下载定义文件",
        onClick: handleDownload,
      },
      {
        key: "delete",
        icon: <DeleteOutlined />,
        label: "删除 Spec",
        danger: true,
        onClick: handleDelete,
      },
    ],
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 标题行：名称（可直接编辑）+ 类型 / 格式 + Save / Generate collection */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 4px 4px",
          minWidth: 0,
        }}
      >
        <FileTextOutlined style={{ fontSize: 16, color: "#8c8c8c", flexShrink: 0 }} />
        <Input
          value={tab.name}
          variant="borderless"
          maxLength={128}
          onChange={(e) => updateSpec(tab.key, { name: e.target.value })}
          style={{ fontSize: 15, fontWeight: 600, flex: 1, minWidth: 0, padding: 0 }}
        />
        <Tag style={{ flexShrink: 0, marginInlineEnd: 0 }}>
          {SPEC_TYPE_LABELS[tab.type]}
        </Tag>
        <Segmented
          size="small"
          value={tab.format}
          onChange={(v) => handleFormatChange(v as SpecFormat)}
          options={SPEC_FORMATS.map((f) => ({ value: f, label: SPEC_FORMAT_LABELS[f] }))}
        />
        <Dropdown menu={generateMenu} trigger={["click"]}>
          <Button size="small" icon={<ThunderboltOutlined />}>
            Generate collection
          </Button>
        </Dropdown>
        <Button
          size="small"
          icon={<SaveOutlined />}
          loading={tab.saving}
          disabled={!dirty}
          onClick={() => void handleSave()}
        >
          Save
        </Button>
        <Dropdown menu={moreMenu} trigger={["click"]}>
          <Button size="small" icon={<MoreOutlined />} />
        </Dropdown>
      </div>

      <Splitter style={{ flex: 1, minHeight: 0 }}>
        <Splitter.Panel defaultSize="58%" min="25%" style={{ paddingRight: 4 }}>
          {/* 内层分栏必须显式撑满：antd Splitter Panel 不会把高度传给子元素，
              断裂后 CodeMirror 会展开为全内容高度被外层裁剪，无法滚动 */}
          <Splitter layout="vertical" style={{ height: "100%" }}>
            <Splitter.Panel defaultSize="68%" min="20%">
              <div
                className="spec-cm"
                style={{
                  height: "100%",
                  border: "1px solid #f0f0f0",
                  borderRadius: 6,
                  overflow: "hidden",
                }}
              >
                <CodeMirror
                  ref={cmRef}
                  value={tab.content}
                  height="100%"
                  extensions={extensions}
                  onChange={(value) => updateSpec(tab.key, { content: value })}
                  basicSetup={{ foldGutter: true, highlightActiveLine: true }}
                />
              </div>
            </Splitter.Panel>
            {/* 无 issue 时收敛为固定小条（最高 100px），不参与分栏拖拽；
                有 issue 时保持可拖拽分栏 */}
            {issues.length === 0 ? (
              <div style={{ height: 100, flexShrink: 0, paddingTop: 4 }}>
                <SpecIssuesPanel issues={issues} onJump={() => {}} />
              </div>
            ) : (
              <Splitter.Panel min="15%" style={{ paddingTop: 4 }}>
                <SpecIssuesPanel
                  issues={issues}
                  onJump={(issue) => {
                    const view = cmRef.current?.view;
                    if (!view) return;
                    const doc = view.state.doc;
                    const line = doc.line(Math.min(Math.max(issue.line, 1), doc.lines));
                    const pos = Math.min(
                      line.from + Math.max(issue.column - 1, 0),
                      line.to,
                    );
                    view.dispatch({
                      selection: { anchor: pos },
                      effects: EditorView.scrollIntoView(pos, { y: "center" }),
                    });
                    view.focus();
                  }}
                />
              </Splitter.Panel>
            )}
          </Splitter>
        </Splitter.Panel>
        <Splitter.Panel min="20%" style={{ paddingLeft: 4 }}>
          <div className="slim-scroll" style={{ height: "100%", overflow: "auto" }}>
            <SpecDocsPreview content={deferredContent} type={tab.type} />
          </div>
        </Splitter.Panel>
      </Splitter>
    </div>
  );
}
