import { DatabaseOutlined, DeleteOutlined, SaveOutlined } from "@ant-design/icons";
import { App, Button, Input, InputNumber, Segmented, Select, Switch, Typography } from "antd";
import { useState, type ReactNode } from "react";
import type { DbConnectionConfig, DbConnectionType } from "@rabbitpost/shared";
import { dbConnectionsApi } from "../../api";
import { useTabSaveHandler } from "../../lib/save-shortcut";
import { useAppStore } from "../../stores/app";
import {
  isTabDirty,
  useTabsStore,
  type DbConnectionTab,
  type DbEnvOverrideDraft,
} from "../../stores/tabs";

interface Props {
  tab: DbConnectionTab;
}

const TYPE_OPTIONS: { value: DbConnectionType; label: string }[] = [
  { value: "mysql", label: "MySQL" },
  { value: "postgres", label: "PostgreSQL" },
  { value: "sqlite", label: "SQLite" },
  { value: "redis", label: "Redis" },
];

/** 切换类型时的默认端口 */
const DEFAULT_PORTS: Partial<Record<DbConnectionType, number>> = {
  mysql: 3306,
  postgres: 5432,
  redis: 6379,
};

/** 表单项：小标题 + 控件（与 Settings 页一致的 12px 次级标题风格） */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
        {label}
      </Typography.Text>
      {children}
    </div>
  );
}

/** 去掉空字符串 / undefined 字段，保持提交数据干净 */
function compact<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj as Record<string, unknown>).filter(
      ([, v]) => v !== undefined && v !== "",
    ),
  ) as Partial<T>;
}

/** 密码输入框：已设置时以占位提示，留空 = 保持不变（服务端不回传已有密码） */
function PasswordField({
  hasPassword,
  value,
  onChange,
}: {
  hasPassword: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Input.Password
      size="small"
      autoComplete="new-password"
      placeholder={hasPassword ? "已设置，留空保持不变" : "未设置"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** 数据库连接编辑页：标题行 + 按类型字段 + 测试连接 + 按环境覆盖 */
export default function DbConnectionEditor({ tab }: Props) {
  const { message } = App.useApp();
  const environments = useAppStore((s) => s.environments);
  const activeEnvironmentId = useAppStore((s) => s.activeEnvironmentId);
  const refreshDbConnections = useAppStore((s) => s.refreshDbConnections);
  const { updateDbConnection, markDbConnectionSaved, setSaving } = useTabsStore();
  const dirty = isTabDirty(tab);
  const [testing, setTesting] = useState(false);

  const isSql = tab.type !== "redis";
  const isNetwork = tab.type !== "sqlite";
  const patch = (p: Parameters<typeof updateDbConnection>[1]) =>
    updateDbConnection(tab.key, p);
  const patchConfig = (c: Partial<DbConnectionConfig>) =>
    patch({ config: { ...tab.config, ...c } });

  const handleTypeChange = (type: DbConnectionType) => {
    patch({
      type,
      config: { ...tab.config, type, port: DEFAULT_PORTS[type] ?? tab.config.port },
    });
  };

  const handleSave = async () => {
    setSaving(tab.key, true);
    try {
      // 环境覆盖：空字段剔除；未输入新密码时省略 password（服务端保留已有密文）；
      // 完全未填写且原本无密码的新条目直接跳过
      const envOverrides = Object.fromEntries(
        Object.entries(tab.envOverrides)
          .map(([envId, o]) => {
            const entry = {
              ...compact({
                host: o.host,
                port: o.port,
                database: o.database,
                username: o.username,
                connectionString: o.connectionString,
              }),
              ...(o.password ? { password: o.password } : {}),
            };
            const keep = Object.keys(entry).length > 0 || o.hasPassword;
            return [envId, entry, keep] as const;
          })
          .filter(([, , keep]) => keep)
          .map(([envId, entry]) => [envId, entry] as const),
      );
      const saved = await dbConnectionsApi.update(tab.connectionId, {
        name: tab.name.trim() || "New Connection",
        type: tab.type,
        config: { ...compact(tab.config), type: tab.type } as DbConnectionConfig,
        ...(tab.password ? { password: tab.password } : {}),
        envOverrides,
      });
      await refreshDbConnections();
      markDbConnectionSaved(tab.key, saved);
      message.success("已保存");
    } finally {
      setSaving(tab.key, false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await dbConnectionsApi.test(tab.connectionId, activeEnvironmentId);
      if (result.success) {
        message.success(`连接成功，延迟 ${result.latencyMs} ms`);
      } else {
        message.error(`连接失败：${result.error}`);
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  // Cmd/Ctrl+S 触发保存；与 Save 按钮同样的禁用条件
  useTabSaveHandler(tab.key, () => {
    if (tab.saving || !dirty) return;
    void handleSave();
  });

  const patchOverride = (envId: string, o: Partial<DbEnvOverrideDraft>) =>
    patch({ envOverrides: { ...tab.envOverrides, [envId]: { ...tab.envOverrides[envId], ...o } } });

  const overriddenEnvIds = new Set(Object.keys(tab.envOverrides));
  const addableEnvs = environments.filter((e) => !overriddenEnvIds.has(e.id));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 第一行：连接标题（可直接编辑）+ 测试连接 + Save */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 4px 4px",
          minWidth: 0,
        }}
      >
        <DatabaseOutlined style={{ fontSize: 16, color: "#8c8c8c", flexShrink: 0 }} />
        <Input
          value={tab.name}
          variant="borderless"
          maxLength={64}
          onChange={(e) => patch({ name: e.target.value })}
          style={{ fontSize: 15, fontWeight: 600, flex: 1, minWidth: 0, padding: 0 }}
        />
        <Button size="small" loading={testing} onClick={() => void handleTest()}>
          测试连接
        </Button>
        <Button
          size="small"
          type="primary"
          icon={<SaveOutlined />}
          loading={tab.saving}
          disabled={!dirty}
          onClick={() => void handleSave()}
        >
          Save
        </Button>
      </div>

      <div
        className="slim-scroll"
        style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px 4px 16px" }}
      >
        <div style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 12 }}>
          {dirty && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              测试连接基于已保存的配置，修改后请先保存再测试。
            </Typography.Text>
          )}

          <Field label="类型">
            <Segmented
              size="small"
              value={tab.type}
              options={TYPE_OPTIONS}
              onChange={(v) => handleTypeChange(v as DbConnectionType)}
            />
          </Field>

          {tab.type === "sqlite" ? (
            <Field label="文件路径">
              <Input
                size="small"
                placeholder="/path/to/db.sqlite（:memory: 为内存库）"
                value={tab.config.filepath ?? ""}
                onChange={(e) => patchConfig({ filepath: e.target.value })}
              />
            </Field>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 8 }}>
              <Field label="Host">
                <Input
                  size="small"
                  placeholder="127.0.0.1"
                  value={tab.config.host ?? ""}
                  onChange={(e) => patchConfig({ host: e.target.value })}
                />
              </Field>
              <Field label="Port">
                <InputNumber
                  size="small"
                  min={0}
                  max={65535}
                  style={{ width: "100%" }}
                  value={tab.config.port ?? null}
                  onChange={(v) => patchConfig({ port: v ?? undefined })}
                />
              </Field>
            </div>
          )}

          {isNetwork && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Field label={tab.type === "redis" ? "Database（db 索引）" : "Database"}>
                <Input
                  size="small"
                  placeholder={tab.type === "redis" ? "0" : "数据库名"}
                  value={tab.config.database ?? ""}
                  onChange={(e) => patchConfig({ database: e.target.value })}
                />
              </Field>
              <Field label="Username">
                <Input
                  size="small"
                  value={tab.config.username ?? ""}
                  onChange={(e) => patchConfig({ username: e.target.value })}
                />
              </Field>
            </div>
          )}

          {isNetwork && (
            <Field label="Password">
              <PasswordField
                hasPassword={tab.hasPassword}
                value={tab.password}
                onChange={(password) => patch({ password })}
              />
            </Field>
          )}

          {(tab.type === "mysql" || tab.type === "postgres") && (
            <Field label="SSL">
              <Switch
                size="small"
                checked={tab.config.ssl ?? false}
                onChange={(ssl) => patchConfig({ ssl })}
              />
            </Field>
          )}

          <Field label="连接串（高级，填写后优先于上方字段）">
            <Input
              size="small"
              className="code-font"
              placeholder={
                tab.type === "redis"
                  ? "redis://user:pass@host:6379/0"
                  : "postgres://user:pass@host:5432/db"
              }
              value={tab.config.connectionString ?? ""}
              onChange={(e) => patchConfig({ connectionString: e.target.value })}
            />
          </Field>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Field label="连接超时（ms）">
              <InputNumber
                size="small"
                min={0}
                style={{ width: "100%" }}
                placeholder="5000"
                value={tab.config.connectTimeoutMs ?? null}
                onChange={(v) => patchConfig({ connectTimeoutMs: v ?? undefined })}
              />
            </Field>
            {isSql && (
              <Field label="只读（仅允许 SELECT）">
                <Switch
                  size="small"
                  checked={tab.config.readOnly ?? false}
                  onChange={(readOnly) => patchConfig({ readOnly })}
                />
              </Field>
            )}
          </div>

          {/* 按环境覆盖：激活该环境时以覆盖值替换 host/port/database/username/password */}
          <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12, marginTop: 4 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <Typography.Text style={{ fontSize: 12, fontWeight: 600 }}>
                按环境覆盖
              </Typography.Text>
              <Select
                size="small"
                placeholder="添加环境覆盖"
                style={{ width: 180 }}
                value={null}
                options={addableEnvs.map((e) => ({ value: e.id, label: e.name }))}
                onChange={(envId: string) =>
                  patch({ envOverrides: { ...tab.envOverrides, [envId]: {} } })
                }
              />
            </div>
            {Object.keys(tab.envOverrides).length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                无覆盖。激活某个环境执行时，可用覆盖值替换连接的主机 / 端口 / 库 / 账号 / 密码。
              </Typography.Text>
            ) : (
              Object.entries(tab.envOverrides).map(([envId, o]) => {
                const envName =
                  environments.find((e) => e.id === envId)?.name ?? "（已删除的环境）";
                return (
                  <div
                    key={envId}
                    style={{
                      border: "1px solid #f0f0f0",
                      borderRadius: 6,
                      padding: 8,
                      marginBottom: 8,
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <Typography.Text style={{ fontSize: 12 }}>{envName}</Typography.Text>
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => {
                          const next = { ...tab.envOverrides };
                          delete next[envId];
                          patch({ envOverrides: next });
                        }}
                      />
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 8 }}>
                      <Field label="Host">
                        <Input
                          size="small"
                          value={o.host ?? ""}
                          onChange={(e) => patchOverride(envId, { host: e.target.value })}
                        />
                      </Field>
                      <Field label="Port">
                        <InputNumber
                          size="small"
                          min={0}
                          max={65535}
                          style={{ width: "100%" }}
                          value={o.port ?? null}
                          onChange={(v) => patchOverride(envId, { port: v ?? undefined })}
                        />
                      </Field>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <Field label="Database">
                        <Input
                          size="small"
                          value={o.database ?? ""}
                          onChange={(e) => patchOverride(envId, { database: e.target.value })}
                        />
                      </Field>
                      <Field label="Username">
                        <Input
                          size="small"
                          value={o.username ?? ""}
                          onChange={(e) => patchOverride(envId, { username: e.target.value })}
                        />
                      </Field>
                    </div>
                    <Field label="Password">
                      <PasswordField
                        hasPassword={o.hasPassword ?? false}
                        value={o.password ?? ""}
                        onChange={(password) => patchOverride(envId, { password })}
                      />
                    </Field>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
