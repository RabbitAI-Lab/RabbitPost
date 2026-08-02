import { Typography } from "antd";
import type { KeyValueItem } from "@rabbitpost/shared";
import KeyValueEditor from "../common/KeyValueEditor";

interface Props {
  variables: KeyValueItem[];
  onChange: (variables: KeyValueItem[]) => void;
}

/**
 * Collection 级变量编辑面板。
 * 作用域为当前 Collection，优先级低于 Environment（Environment 同名变量覆盖）。
 * 列表样式与请求 Params 一致：Variable / Value / Description。
 */
export default function CollectionVariablesPanel({ variables, onChange }: Props) {
  return (
    <div style={{ padding: "4px 0" }}>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
        变量作用域为当前 Collection，发送请求时自动替换 {"{{var}}"}；同名变量会被 Environment 覆盖。
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
