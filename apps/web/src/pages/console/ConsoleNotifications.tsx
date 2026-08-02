import { BellOutlined, CheckOutlined } from "@ant-design/icons";
import { Alert, Badge, Button, Card, Empty, List, Space, Tag, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import type { Notification } from "@rabbitpost/shared";
import { orgsApi } from "../../api/orgs";
import { useConsoleStore } from "../../stores/console";

const LEVEL_COLOR: Record<string, string> = {
  org_admin: "orange",
  team_admin: "blue",
};

const LEVEL_LABEL: Record<string, string> = {
  org_admin: "企业管理员",
  team_admin: "团队管理员",
};

export default function ConsoleNotifications() {
  const orgId = useConsoleStore((s) => s.currentOrgId);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      setNotifications(
        await orgsApi.notifications(orgId, {
          unread: filter === "unread",
          limit: 100,
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [orgId, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleMarkAllRead = async () => {
    await orgsApi.markNotificationRead(orgId!);
    await load();
  };

  const handleMarkRead = async (id: string) => {
    await orgsApi.markNotificationRead(orgId!, id);
    await load();
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <div style={{ maxWidth: 800 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Space>
          <Typography.Title level={4} style={{ margin: 0 }}>
            <BellOutlined /> 通知
          </Typography.Title>
          {unreadCount > 0 && <Badge count={unreadCount} />}
        </Space>
        <Space>
          {filter === "all" ? (
            <Button onClick={() => setFilter("unread")}>只看未读</Button>
          ) : (
            <Button onClick={() => setFilter("all")}>显示全部</Button>
          )}
          {unreadCount > 0 && (
            <Button icon={<CheckOutlined />} onClick={() => void handleMarkAllRead()}>
              全部已读
            </Button>
          )}
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        message="团队/工作区变更会通知企业管理员；团队成员变更会通知团队管理员"
        style={{ marginBottom: 16 }}
      />

      {notifications.length === 0 ? (
        <Card>
          <Empty description="暂无通知" />
        </Card>
      ) : (
        <Card loading={loading}>
          <List
            dataSource={notifications}
            renderItem={(n) => (
              <List.Item
                actions={
                  !n.read
                    ? [
                        <Button
                          size="small"
                          type="link"
                          onClick={() => void handleMarkRead(n.id)}
                        >
                          标记已读
                        </Button>,
                      ]
                    : undefined
                }
              >
                <List.Item.Meta
                  avatar={
                    !n.read ? (
                      <Badge status="processing" />
                    ) : (
                      <span style={{ width: 8, display: "inline-block" }} />
                    )
                  }
                  title={
                    <Space>
                      <span style={{ fontWeight: n.read ? 400 : 600 }}>{n.title}</span>
                      <Tag color={LEVEL_COLOR[n.level]} style={{ fontSize: 11 }}>
                        {LEVEL_LABEL[n.level]}
                      </Tag>
                      {n.teamName && <Tag style={{ fontSize: 11 }}>{n.teamName}</Tag>}
                    </Space>
                  }
                  description={
                    <>
                      <div style={{ marginBottom: 4 }}>{n.body}</div>
                      <div style={{ fontSize: 12, color: "#999" }}>
                        {n.actorName ?? "System"} · {new Date(n.createdAt).toLocaleString()}
                      </div>
                    </>
                  }
                />
              </List.Item>
            )}
          />
        </Card>
      )}
    </div>
  );
}
