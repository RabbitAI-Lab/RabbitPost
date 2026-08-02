import { CopyOutlined, DownloadOutlined, LinkOutlined } from "@ant-design/icons";
import { App, Button, Input, Modal, Space, Spin, Typography } from "antd";
import { useEffect, useState } from "react";
import type { Collection, CollectionShare } from "@rabbitpost/shared";
import { buildCollectionFile } from "@rabbitpost/shared";
import { collectionsApi } from "../../api";
import { downloadCollectionFile, shareUrl } from "../../lib/collection-file";

interface Props {
  collection: Collection | null;
  open: boolean;
  onClose: () => void;
}

/**
 * 导出 Collection：
 * - 在线链接（公开只读，返回 RabbitPost Collection JSON，可随时撤销）
 * - 导出 JSON 文件
 */
export default function ExportCollectionModal({ collection, open, onClose }: Props) {
  const { message } = App.useApp();
  const [share, setShare] = useState<CollectionShare | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [exporting, setExporting] = useState(false);

  // 打开时拉取已有链接（可能是之前生成的）
  useEffect(() => {
    if (!open || !collection) return;
    setShare(null);
    setLoading(true);
    collectionsApi
      .share(collection.id)
      .then((r) => setShare(r.share))
      .catch((e: unknown) => message.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [open, collection, message]);

  const handleCreateShare = async () => {
    if (!collection) return;
    setWorking(true);
    try {
      const r = await collectionsApi.createShare(collection.id);
      setShare(r.share);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const handleRevokeShare = async () => {
    if (!collection) return;
    setWorking(true);
    try {
      await collectionsApi.revokeShare(collection.id);
      setShare(null);
      message.success("链接已撤销");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const handleCopy = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(shareUrl(share.token));
      message.success("链接已复制");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  /** 导出 JSON 文件：取最新树数据，避免侧栏缓存不全 */
  const handleExportJson = async () => {
    if (!collection) return;
    setExporting(true);
    try {
      const tree = await collectionsApi.tree(collection.id);
      downloadCollectionFile(buildCollectionFile(collection, tree));
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal
      title={`导出 Collection${collection ? `：${collection.name}` : ""}`}
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      width={560}
    >
      <Spin spinning={loading}>
        {/* 在线链接 */}
        <div
          style={{
            background: "#fff7f3",
            border: "1px solid #ffd9c9",
            borderRadius: 6,
            padding: 12,
          }}
        >
          <div style={{ fontSize: 13, marginBottom: 10 }}>
            <b>和同事协作？</b>生成在线链接分享，对方粘贴链接即可导入。
          </div>
          {share ? (
            <>
              <Space.Compact style={{ width: "100%" }}>
                <Input readOnly value={shareUrl(share.token)} />
                <Button icon={<CopyOutlined />} onClick={() => void handleCopy()}>
                  复制
                </Button>
              </Space.Compact>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginTop: 6,
                }}
              >
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  拿到链接的人无需登录即可读取该 Collection 的全部内容
                </Typography.Text>
                <Button
                  type="link"
                  danger
                  size="small"
                  loading={working}
                  onClick={() => void handleRevokeShare()}
                >
                  撤销链接
                </Button>
              </div>
            </>
          ) : (
            <Button
              type="primary"
              icon={<LinkOutlined />}
              loading={working}
              onClick={() => void handleCreateShare()}
            >
              生成分享链接
            </Button>
          )}
        </div>

        {/* 导出文件 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 16,
          }}
        >
          <Typography.Text strong style={{ fontSize: 13 }}>
            导出为文件：
          </Typography.Text>
          <Button
            icon={<DownloadOutlined />}
            loading={exporting}
            onClick={() => void handleExportJson()}
          >
            导出 JSON
          </Button>
        </div>
      </Spin>
    </Modal>
  );
}
