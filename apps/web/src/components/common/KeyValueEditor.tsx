import { DeleteOutlined } from "@ant-design/icons";
import { Button, Checkbox, Input, Select, Table, Upload } from "antd";
import { useState } from "react";
import type { KeyValueItem } from "@rabbitpost/shared";
import VarInput from "./variable/VarInput";

let seq = 0;
export function newKvItem(partial?: Partial<KeyValueItem>): KeyValueItem {
  return {
    id: `kv-${Date.now()}-${seq++}`,
    key: "",
    value: "",
    enabled: true,
    ...partial,
  };
}

interface Props {
  items: KeyValueItem[];
  onChange: (items: KeyValueItem[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** 列头标题（缺省沿用对应 placeholder 文案） */
  keyTitle?: string;
  valueTitle?: string;
  /** 草稿行 Key 输入框的 placeholder（缺省沿用 keyPlaceholder） */
  draftKeyPlaceholder?: string;
  /** 环境变量场景显示 secret 列 */
  showSecret?: boolean;
  /** 是否显示 Description 列 */
  showDescription?: boolean;
  /** form-data 场景：Key 末尾显示 text/file 类型下拉，file 时 Value 列变为文件选择 */
  showKeyType?: boolean;
  /** Key / Value 输入框开启 {{var}} 变量高亮（环境变量定义处不应开启） */
  highlightVars?: boolean;
}

/** Postman 风格 Key-Value 表格编辑器：末行自动追加空行 */
export default function KeyValueEditor({
  items,
  onChange,
  keyPlaceholder = "Key",
  valuePlaceholder = "Value",
  keyTitle,
  valueTitle,
  draftKeyPlaceholder,
  showSecret = false,
  showDescription = false,
  showKeyType = false,
  highlightVars = false,
}: Props) {
  // 草稿行预先持有真实 id：提交时沿用该 id，保证 rowKey 不变、Input 不重建、焦点不丢
  const [draftId, setDraftId] = useState(() => newKvItem().id);

  const update = (id: string, patch: Partial<KeyValueItem>) => {
    // 在草稿行输入时，自动提交为新的一行，并为下一条草稿行换新 id
    if (id === draftId) {
      onChange([...items, { ...newKvItem(patch), id: draftId }]);
      setDraftId(newKvItem().id);
      return;
    }
    onChange(items.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  };

  const remove = (id: string) => {
    onChange(items.filter((it) => it.id !== id));
  };

  const columns = [
    {
      title: "",
      dataIndex: "enabled",
      width: 36,
      render: (_: unknown, row: KeyValueItem) =>
        row.id === draftId ? null : (
          <Checkbox
            checked={row.enabled}
            onChange={(e) => update(row.id, { enabled: e.target.checked })}
          />
        ),
    },
    {
      title: keyTitle ?? keyPlaceholder,
      dataIndex: "key",
      render: (_: unknown, row: KeyValueItem) => {
        const placeholder =
          row.id === draftId ? (draftKeyPlaceholder ?? keyPlaceholder) : keyPlaceholder;
        const setKey = (v: string) => update(row.id, { key: v });
        const suffix = showKeyType ? (
          <Select
            size="small"
            variant="borderless"
            value={row.type ?? "text"}
            style={{ width: 66, marginRight: -7 }}
            options={[
              { value: "text", label: "Text" },
              { value: "file", label: "File" },
            ]}
            onChange={(type) =>
              // 切回 text 时清空已选文件；切到 file 时清空文本值
              update(
                row.id,
                type === "text"
                  ? { type, fileBase64: undefined, fileName: undefined }
                  : { type, value: "" },
              )
            }
          />
        ) : undefined;
        return highlightVars ? (
          <VarInput
            size="small"
            variant="filled"
            value={row.key}
            placeholder={placeholder}
            onChange={setKey}
            suffix={suffix}
          />
        ) : (
          <Input
            size="small"
            variant="filled"
            value={row.key}
            placeholder={placeholder}
            onChange={(e) => setKey(e.target.value)}
            suffix={suffix}
          />
        );
      },
    },
    {
      title: valueTitle ?? valuePlaceholder,
      dataIndex: "value",
      render: (_: unknown, row: KeyValueItem) =>
        showKeyType && row.type === "file" ? (
          <Upload
            showUploadList={false}
            beforeUpload={(file) => {
              // 读为 base64 存入条目；阻止 antd 自动上传
              const reader = new FileReader();
              reader.onload = () => {
                const result = String(reader.result ?? "");
                const fileBase64 = result.slice(result.indexOf(",") + 1);
                update(row.id, { fileBase64, fileName: file.name });
              };
              reader.readAsDataURL(file);
              return false;
            }}
          >
            <Button size="small">{row.fileName ?? "Select File"}</Button>
          </Upload>
        ) : highlightVars ? (
          <VarInput
            size="small"
            variant="filled"
            value={row.value}
            placeholder={valuePlaceholder}
            onChange={(v) => update(row.id, { value: v })}
          />
        ) : (
          <Input
            size="small"
            variant="filled"
            value={row.value}
            placeholder={valuePlaceholder}
            onChange={(e) => update(row.id, { value: e.target.value })}
          />
        ),
    },
    ...(showDescription
      ? [
          {
            title: "Description",
            dataIndex: "description",
            render: (_: unknown, row: KeyValueItem) => (
              <Input
                size="small"
                variant="filled"
                value={row.description ?? ""}
                placeholder="Description"
                onChange={(e) => update(row.id, { description: e.target.value })}
              />
            ),
          },
        ]
      : []),
    ...(showSecret
      ? [
          {
            title: "Secret",
            dataIndex: "secret",
            width: 60,
            render: (_: unknown, row: KeyValueItem) => (
              <Checkbox
                checked={Boolean((row as { secret?: boolean }).secret)}
                onChange={(e) =>
                  update(row.id, { secret: e.target.checked } as Partial<KeyValueItem>)
                }
              />
            ),
          },
        ]
      : []),
    {
      title: "",
      dataIndex: "actions",
      width: 36,
      render: (_: unknown, row: KeyValueItem) =>
        row.id === draftId ? null : (
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => remove(row.id)}
          />
        ),
    },
  ];

  // 末尾常驻一行待填写草稿行（含空数据时也展示表头与草稿行）
  const rows: KeyValueItem[] = [
    ...items,
    { id: draftId, key: "", value: "", enabled: true },
  ];

  return (
    <Table<KeyValueItem>
      size="small"
      rowKey="id"
      columns={columns as never}
      dataSource={rows}
      pagination={false}
    />
  );
}
