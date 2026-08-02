import { CopyOutlined } from "@ant-design/icons";
import { App, Button, Tooltip } from "antd";

interface Props {
  command: string;
  /** 多行命令按原样保留换行 */
  multiline?: boolean;
}

/** 命令展示块：等宽字体 + 一键复制（CLI 引导中重复使用） */
export default function CommandBlock({ command, multiline }: Props) {
  const { message } = App.useApp();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      message.success("已复制");
    } catch (e) {
      // 非安全上下文（http 且非 localhost）下 clipboard 不可用，提示原因便于手动复制
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        background: "#f6f6f6",
        border: "1px solid #f0f0f0",
        borderRadius: 6,
        padding: "8px 8px 8px 12px",
      }}
    >
      <code
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12,
          lineHeight: "20px",
          whiteSpace: multiline ? "pre-wrap" : "nowrap",
          overflowX: "auto",
          wordBreak: "break-all",
        }}
      >
        {command}
      </code>
      <Tooltip title="复制">
        <Button
          type="text"
          size="small"
          icon={<CopyOutlined />}
          onClick={() => void copy()}
        />
      </Tooltip>
    </div>
  );
}
