import { App, Button, Card, Col, Divider, Form, Input, InputNumber, Row, Tag, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { orgsApi } from "../../api/orgs";
import { useConsoleStore } from "../../stores/console";

interface OrgSettings {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  domain: string | null;
  plan: string;
  status: string;
  seatLimit: number;
  requestQuota: number;
  ssoConfig: Record<string, unknown> | null;
  adminEmail: string | null;
}

interface SettingsFormValues {
  name: string;
  domain?: string;
  logoUrl?: string;
  seatLimit?: number;
  requestQuota?: number;
  ssoConfigText?: string;
  adminEmail?: string;
}

export default function ConsoleSettings() {
  const { message } = App.useApp();
  const orgId = useConsoleStore((s) => s.currentOrgId);
  const [data, setData] = useState<OrgSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<SettingsFormValues>();

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const d = await orgsApi.getSettings(orgId);
      setData(d);
      form.setFieldsValue({
        name: d.name,
        domain: d.domain ?? "",
        logoUrl: d.logoUrl ?? "",
        seatLimit: d.seatLimit || undefined,
        requestQuota: d.requestQuota || undefined,
        ssoConfigText: d.ssoConfig ? JSON.stringify(d.ssoConfig, null, 2) : "",
        adminEmail: d.adminEmail ?? "",
      });
    } finally {
      setLoading(false);
    }
  }, [orgId, form]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      // 解析 SSO 配置 JSON
      let ssoConfig: Record<string, unknown> | null = null;
      const ssoText = values.ssoConfigText?.trim();
      if (ssoText) {
        try {
          ssoConfig = JSON.parse(ssoText);
        } catch {
          message.error("SSO 配置 JSON 格式无效");
          setSaving(false);
          return;
        }
      }
      await orgsApi.updateSettings(orgId!, {
        name: values.name,
        domain: values.domain || null,
        logoUrl: values.logoUrl || null,
        seatLimit: values.seatLimit ?? 0,
        requestQuota: values.requestQuota ?? 0,
        ssoConfig,
        adminEmail: values.adminEmail || null,
      });
      message.success("设置已保存");
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) return <div>Loading...</div>;
  if (!data) return null;

  return (
    <div style={{ maxWidth: 800 }}>
      <Typography.Title level={4} style={{ marginBottom: 24 }}>
        企业设置
      </Typography.Title>

      {/* 单个 Form 包裹所有 Card，避免多 Form 实例共享冲突 */}
      <Form form={form} layout="vertical">
        <Card title="基本信息" size="small" loading={loading} style={{ marginBottom: 16 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="name" label="企业名称" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="Slug">
                <Input value={data.slug} disabled />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="domain" label="企业域名">
                <Input placeholder="company.com（用于邮箱自动加入）" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="logoUrl" label="Logo URL">
                <Input placeholder="https://..." />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        <Card title="管理员通知" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            name="adminEmail"
            label="企业管理员邮箱"
            help="增删改团队、工作区时通知此邮箱"
          >
            <Input placeholder="admin@company.com" />
          </Form.Item>
        </Card>

        <Card title="配额管理" size="small" style={{ marginBottom: 16 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="seatLimit" label="席位上限（0 = 不限）">
                <InputNumber min={0} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="requestQuota" label="每月请求配额（0 = 不限）">
                <InputNumber min={0} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        <Card title="SSO / 安全策略" size="small" style={{ marginBottom: 16 }}>
          <Form.Item label="当前套餐">
            <Tag color="purple">{data.plan.toUpperCase()}</Tag>{" "}
            <Tag color={data.status === "active" ? "green" : "red"}>{data.status}</Tag>
          </Form.Item>
          <Form.Item
            name="ssoConfigText"
            label="SSO 配置（SAML 2.0 / OIDC）"
            help="通过 JSON 配置企业身份提供商"
          >
            <Input.TextArea
              rows={4}
              placeholder='{"provider": "saml", "entryPoint": "...", "cert": "..."}'
            />
          </Form.Item>
        </Card>
      </Form>

      <Divider />
      <Button type="primary" loading={saving} onClick={() => void handleSave()}>
        保存设置
      </Button>
    </div>
  );
}
