import { App, Input, Modal } from "antd";
import { useState } from "react";
import { collectionsApi } from "../../api";
import { useAppStore } from "../../stores/app";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** 新建 Collection 弹窗（SidebarNav 与 CollectionsPanel 共用） */
export default function NewCollectionModal({ open, onClose }: Props) {
  const { message } = App.useApp();
  const currentWorkspaceId = useAppStore((s) => s.currentWorkspaceId);
  const refreshCollections = useAppStore((s) => s.refreshCollections);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleCreate = async () => {
    if (!currentWorkspaceId || !name.trim()) return;
    setSubmitting(true);
    try {
      await collectionsApi.create(currentWorkspaceId, name.trim());
      await refreshCollections();
      setName("");
      onClose();
      message.success("Collection 已创建");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="新建 Collection"
      open={open}
      onOk={() => void handleCreate()}
      onCancel={onClose}
      okText="创建"
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnHidden
    >
      <Input
        placeholder="Collection 名称"
        value={name}
        maxLength={128}
        onChange={(e) => setName(e.target.value)}
        onPressEnter={() => void handleCreate()}
      />
    </Modal>
  );
}
