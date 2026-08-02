import { CopyOutlined, DesktopOutlined } from "@ant-design/icons";
import { App, Button, Modal, Select, Tooltip } from "antd";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useState } from "react";
import MarkdownEditor from "../common/MarkdownEditor";
import {
  detectFormat,
  getLanguageExtension,
  prettyPrint,
  RESPONSE_FORMATS,
  RESPONSE_FORMAT_LABELS,
  toBase64,
  toHexDump,
  type ResponseFormat,
} from "../../lib/response-format";

interface Props {
  bodyText?: string;
  contentType?: string;
}

/**
 * Response Body 查看器（对齐 Postman）：
 * - 顶部格式下拉，根据 content-type 自动推断可手动覆盖
 * - CodeMirror 只读模式做语法高亮 + 折叠 + 行号
 * - Markdown 额外提供「源码 / 预览」切换
 * - Hex 显示经典 hex dump；Base64 显示编码后的字符串
 */
export default function ResponseBodyViewer({ bodyText, contentType }: Props) {
  const { message } = App.useApp();
  const detected = useMemo(
    () => detectFormat(contentType, bodyText),
    [contentType, bodyText],
  );
  const [format, setFormat] = useState<ResponseFormat>(detected);
  const [previewOpen, setPreviewOpen] = useState(false);

  // 新响应到来时重置为自动推断的格式
  useEffect(() => {
    setFormat(detected);
  }, [detected]);

  const extensions = useMemo(
    () => [EditorView.lineWrapping, ...getLanguageExtension(format)],
    [format],
  );

  /** 按当前格式渲染最终文本 */
  const displayText = useMemo(() => {
    if (!bodyText) return "";
    switch (format) {
      case "hex":
        return toHexDump(bodyText);
      case "base64":
        return toBase64(bodyText);
      default:
        return prettyPrint(bodyText, format);
    }
  }, [bodyText, format]);

  const handleCopy = () => {
    void navigator.clipboard.writeText(displayText).then(() => {
      message.success("已复制到剪贴板");
    });
  };

  /** Preview 弹窗内容：根据当前格式渲染对应预览（同 Postman） */
  const renderPreviewContent = () => {
    const source = bodyText ?? "";
    switch (format) {
      // HTML / XML：用 sandbox iframe 渲染为浏览器实际页面
      case "html":
      case "xml":
        return (
          <iframe
            title="response-preview"
            srcDoc={source}
            sandbox="allow-same-origin"
            style={{ width: "100%", height: "100%", border: "none" }}
          />
        );
      // Markdown：用 Cherry Markdown 渲染为富文本
      case "markdown":
        return (
          <div style={{ height: "100%", overflow: "auto", padding: 16 }}>
            <MarkdownEditor initialValue={source} mode="preview" onChange={() => {}} />
          </div>
        );
      // JSON：美化后的纯文本
      case "json":
        return (
          <pre
            className="code-font"
            style={{ margin: 0, padding: 16, whiteSpace: "pre-wrap", wordBreak: "break-all" }}
          >
            {prettyPrint(source, "json")}
          </pre>
        );
      // 其他格式：展示美化后的文本
      default:
        return (
          <pre
            className="code-font"
            style={{ margin: 0, padding: 16, whiteSpace: "pre-wrap", wordBreak: "break-all" }}
          >
            {displayText}
          </pre>
        );
    }
  };

  const previewModal = (
    <Modal
      title={`${RESPONSE_FORMAT_LABELS[format]} Preview`}
      open={previewOpen}
      onCancel={() => setPreviewOpen(false)}
      footer={null}
      width="90vw"
      styles={{ body: { height: "80vh", padding: 0, overflow: "auto" } }}
      destroyOnClose
    >
      {renderPreviewContent()}
    </Modal>
  );

  return (
    <div
      className="response-body-root"
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      <ResponseBodyToolbar
        format={format}
        onFormatChange={setFormat}
        onCopy={handleCopy}
        onPreview={() => setPreviewOpen(true)}
      />
      <div
        className="response-cm"
        style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
      >
        <CodeMirror
          value={displayText}
          height="100%"
          readOnly
          editable={false}
          extensions={extensions}
          basicSetup={{
            foldGutter: true,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            searchKeymap: true,
          }}
        />
      </div>
      {previewModal}
    </div>
  );
}

/** Body 工具条：格式下拉 + Preview + 复制 */
function ResponseBodyToolbar({
  format,
  onFormatChange,
  onCopy,
  onPreview,
}: {
  format: ResponseFormat;
  onFormatChange: (f: ResponseFormat) => void;
  onCopy: () => void;
  onPreview: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 0",
        flexShrink: 0,
      }}
    >
      {/* 触发器宽度随选中项文字自适应；popupMatchSelectWidth=false 使弹出框独立按内容自适应 */}
      <Select
        size="small"
        variant="borderless"
        value={format}
        onChange={(v) => onFormatChange(v as ResponseFormat)}
        popupMatchSelectWidth={false}
        options={RESPONSE_FORMATS.map((f) => ({
          value: f,
          label: RESPONSE_FORMAT_LABELS[f],
        }))}
      />
      <Button
        type="link"
        size="small"
        icon={<DesktopOutlined />}
        onClick={onPreview}
      >
        Preview
      </Button>
      <div style={{ flex: 1 }} />
      <Tooltip title="复制全部">
        <Button
          type="text"
          size="small"
          icon={<CopyOutlined />}
          onClick={onCopy}
        />
      </Tooltip>
    </div>
  );
}
