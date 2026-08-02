import {
  BankOutlined,
  DashboardOutlined,
  TeamOutlined,
  AppstoreOutlined,
  BarChartOutlined,
  KeyOutlined,
  AuditOutlined,
  SettingOutlined,
  CreditCardOutlined,
  ArrowLeftOutlined,
  PlusOutlined,
  BellOutlined,
} from "@ant-design/icons";
import { App, Button, Form, Input, Layout, Menu, Modal, Select, Spin, Tag } from "antd";
import { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { orgsApi } from "../../api/orgs";
import { useConsoleStore } from "../../stores/console";

const ORG_ROLE_COLOR: Record<string, string> = {
  owner: "red",
  admin: "orange",
  billing: "blue",
  member: "default",
};

export default function ConsoleLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = App.useApp();
  const { orgs, currentOrgId, bootstrapped, bootstrap, selectOrg, refreshOrgs } =
    useConsoleStore();

  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [orgForm] = Form.useForm<{ name: string; domain?: string }>();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const handleCreateOrg = async () => {
    const { name, domain } = await orgForm.validateFields();
    setCreating(true);
    try {
      const org = await orgsApi.create({ name, domain: domain || undefined });
      await refreshOrgs();
      selectOrg(org.id);
      setCreateOrgOpen(false);
      orgForm.resetFields();
      message.success(`企业「${org.name}」已创建`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  if (!bootstrapped) {
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (orgs.length === 0) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
        <BankOutlined style={{ fontSize: 48, color: "#ff6c37" }} />
        <p style={{ color: "#666", fontSize: 16 }}>您还没有加入任何企业组织</p>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setCreateOrgOpen(true)}
        >
          创建企业
        </Button>
        <Link to="/">
          <ArrowLeftOutlined /> 返回主应用
        </Link>

        <Modal
          title="创建企业"
          open={createOrgOpen}
          onCancel={() => setCreateOrgOpen(false)}
          onOk={() => void handleCreateOrg()}
          confirmLoading={creating}
          okText="创建"
          cancelText="取消"
          destroyOnHidden
        >
          <Form form={orgForm} layout="vertical" preserve={false}>
            <Form.Item
              name="name"
              label="企业名称"
              rules={[{ required: true, message: "请输入企业名称" }]}
            >
              <Input placeholder="如：Acme Corporation" maxLength={128} />
            </Form.Item>
            <Form.Item name="domain" label="企业域名（可选）">
              <Input placeholder="acme.com" />
            </Form.Item>
          </Form>
        </Modal>
      </div>
    );
  }

  const currentOrg = orgs.find((o) => o.id === currentOrgId);

  const menuItems = [
    {
      key: "/console",
      icon: <DashboardOutlined />,
      label: <Link to="/console">总览</Link>,
    },
    {
      key: "/console/teams",
      icon: <TeamOutlined />,
      label: <Link to="/console/teams">团队管理</Link>,
    },
    {
      key: "/console/members",
      icon: <TeamOutlined />,
      label: <Link to="/console/members">成员管理</Link>,
    },
    {
      key: "/console/workspaces",
      icon: <AppstoreOutlined />,
      label: <Link to="/console/workspaces">工作区</Link>,
    },
    {
      key: "/console/usage",
      icon: <BarChartOutlined />,
      label: <Link to="/console/usage">用量统计</Link>,
    },
    {
      key: "/console/api-keys",
      icon: <KeyOutlined />,
      label: <Link to="/console/api-keys">API Keys</Link>,
    },
    {
      key: "/console/runners",
      icon: <KeyOutlined />,
      label: <Link to="/console/runners">Runners</Link>,
    },
    {
      key: "/console/audit",
      icon: <AuditOutlined />,
      label: <Link to="/console/audit">审计日志</Link>,
    },
    {
      key: "/console/notifications",
      icon: <BellOutlined />,
      label: <Link to="/console/notifications">通知</Link>,
    },
    {
      key: "/console/settings",
      icon: <SettingOutlined />,
      label: <Link to="/console/settings">设置</Link>,
    },
    {
      key: "/console/billing",
      icon: <CreditCardOutlined />,
      label: <Link to="/console/billing">计费</Link>,
    },
  ];

  const selectedKey = menuItems
    .filter((m) => location.pathname.startsWith(m.key))
    .sort((a, b) => b.key.length - a.key.length)[0]?.key ?? "/console";

  return (
    <Layout style={{ height: "100%" }}>
      <Layout.Header
        style={{
          padding: "0 16px",
          background: "#fff",
          height: 48,
          lineHeight: "48px",
          borderBottom: "1px solid #f0f0f0",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span style={{ color: "#ff6c37", fontWeight: 700, fontSize: 14, whiteSpace: "nowrap" }}>
          <BankOutlined /> 企业控制台
        </span>
        {currentOrg && (
          <>
            <Select
              value={currentOrgId ?? undefined}
              onChange={(v) => selectOrg(v)}
              style={{ width: 240 }}
              options={orgs.map((o) => ({
                value: o.id,
                label: (
                  <span>
                    {o.name}{" "}
                    {o.role && (
                      <Tag color={ORG_ROLE_COLOR[o.role]} style={{ fontSize: 11 }}>
                        {o.role}
                      </Tag>
                    )}
                  </span>
                ),
              }))}
            />
            <Tag
              color={currentOrg.status === "active" ? "green" : "red"}
              style={{ marginLeft: 4 }}
            >
              {currentOrg.plan.toUpperCase()}
            </Tag>
          </>
        )}
        <div style={{ flex: 1 }} />
        <a onClick={() => navigate("/")} style={{ color: "#666", cursor: "pointer" }}>
          <ArrowLeftOutlined /> 返回主应用
        </a>
      </Layout.Header>
      <Layout>
        <Layout.Sider
          width={220}
          style={{ background: "#fff", borderRight: "1px solid #f0f0f0" }}
        >
          <Menu
            mode="inline"
            selectedKeys={[selectedKey]}
            items={menuItems}
            style={{ borderRight: "none", paddingTop: 8 }}
          />
        </Layout.Sider>
        <Layout.Content style={{ overflow: "auto", background: "#f5f5f5", padding: 24 }}>
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
