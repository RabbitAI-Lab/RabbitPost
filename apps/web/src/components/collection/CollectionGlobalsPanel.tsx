import { Typography } from "antd";
import type { KeyValueItem } from "@rabbitpost/shared";
import KeyValueEditor from "../common/KeyValueEditor";

interface Props {
  variables: KeyValueItem[];
  onChange: (variables: KeyValueItem[]) => void;
}

/**
 * Workspace 级全局变量编辑面板。
 * 作用域为当前 Workspace（跨 Collection 可用），优先级最低：同名变量会被 Collection / Environment 覆盖。
 * 列表样式与 Collection Variables 一致：Variable / Value / Description。
 */
export default function CollectionGlobalsPanel({ variables, onChange }: Props) {
  return (
    <div style={{ padding: "4px 0" }}>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
        全局变量作用域为当前 Workspace，所有 Collection 的请求都可用 {"{{var}}"} 引用；同名变量会被 Collection Variables 和 Environment 覆盖。
      </Typography.Text>
      <KeyValueEditor
        items={variables}
        onChange={onChange}
        keyPlaceholder="Variable"
        keyTitle="Variable"
        valuePlaceholder="Value"
        valueTitle="Value"
        showDescription
      />
    </div>
  );
}
