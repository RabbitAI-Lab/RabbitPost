import { InboxOutlined } from "@ant-design/icons";
import { App, Input, Modal, Segmented, Typography, Upload } from "antd";
import { useState } from "react";
import {
  SPEC_FORMAT_LABELS,
  SPEC_FORMATS,
  SPEC_TYPE_LABELS,
  SPEC_TYPES,
  type SpecFormat,
  type SpecType,
} from "@rabbitpost/shared";
import { specsApi } from "../../api";
import { useAppStore } from "../../stores/app";
import { useTabsStore } from "../../stores/tabs";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** 由导入文件的内容推断 spec 类型（读不出版本时保持当前选择） */
function detectType(content: string): SpecType | null {
  const openapi = /^\s*["']?openapi["']?\s*:\s*["']?(\d+\.\d+)/m.exec(content);
  if (openapi) return openapi[1] === "3.1" ? "openapi-3.1" : "openapi-3.0";
  if (/^\s*["']?asyncapi["']?\s*:\s*["']?2\./m.test(content)) return "asyncapi-2.0";
  return null;
}

/**
 * 新建 spec 弹窗（对齐 Postman「Create spec」）：
 * 名称 + 定义类型 + 文件格式，可选直接从本地定义文件导入。
 */
export default function NewSpecModal({ open, onClose }: Props) {
  const { message } = App.useApp();
  const currentWorkspaceId = useAppStore((s) => s.currentWorkspaceId);
  const refreshSpecs = useAppStore((s) => s.refreshSpecs);
  const openSpec = useTabsStore((s) => s.openSpec);

  const [name, setName] = useState("");
  const [type, setType] = useState<SpecType>("openapi-3.0");
  const [format, setFormat] = useState<SpecFormat>("yaml");
  const [imported, setImported] = useState<{ fileName: string; content: string } | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setName("");
    setType("openapi-3.0");
    setFormat("yaml");
    setImported(null);
  };

  const handleCreate = async () => {
    if (!currentWorkspaceId) return;
    const specName = name.trim() || imported?.fileName.replace(/\.[^.]+$/, "") || "";
    if (!specName) {
      message.error("请填写 spec 名称");
      return;
    }
    setSubmitting(true);
    try {
      const spec = await specsApi.create(currentWorkspaceId, {
        name: specName,
        type,
        format,
        content: imported?.content,
      });
      await refreshSpecs();
      openSpec(spec);
      reset();
      onClose();
      message.success(`已创建「${spec.name}」`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleFile = async (file: File) => {
    const content = await file.text();
    const detected = detectType(content);
    if (detected) setType(detected);
    setFormat(/\.json$/i.test(file.name) ? "json" : "yaml");
    setImported({ fileName: file.name, content });
    if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, ""));
  };

  return (
    <Modal
      title="新建 Spec"
      open={open}
      onOk={() => void handleCreate()}
      onCancel={() => {
        reset();
        onClose();
      }}
      okText="创建"
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnHidden
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            名称
          </Typography.Text>
          <Input
            placeholder="Spec 名称"
            value={name}
            maxLength={128}
            onChange={(e) => setName(e.target.value)}
            onPressEnter={() => void handleCreate()}
            style={{ marginTop: 4 }}
          />
        </div>

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            定义类型
          </Typography.Text>
          <div style={{ marginTop: 4 }}>
            <Segmented
              value={type}
              onChange={(v) => setType(v as SpecType)}
              options={SPEC_TYPES.map((t) => ({ value: t, label: SPEC_TYPE_LABELS[t] }))}
            />
          </div>
        </div>

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            文件格式
          </Typography.Text>
          <div style={{ marginTop: 4 }}>
            <Segmented
              value={format}
              onChange={(v) => setFormat(v as SpecFormat)}
              options={SPEC_FORMATS.map((f) => ({
                value: f,
                label: SPEC_FORMAT_LABELS[f],
              }))}
            />
          </div>
        </div>

        <Upload.Dragger
          accept=".yaml,.yml,.json"
          maxCount={1}
          showUploadList={false}
          beforeUpload={(file) => {
            void handleFile(file);
            return false; // 阻止自动上传，仅本地读取内容
          }}
        >
          <p style={{ margin: "6px 0" }}>
            <InboxOutlined style={{ fontSize: 28, color: "#ff6c37" }} />
          </p>
          <p style={{ fontSize: 13, margin: 0 }}>
            {imported ? `已选择：${imported.fileName}` : "可选：导入已有定义文件"}
          </p>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            支持 .yaml / .yml / .json；不导入时用起始模板创建
          </Typography.Text>
        </Upload.Dragger>
      </div>
    </Modal>
  );
}
