import { Input, InputNumber, Select, Switch, Tooltip, Typography } from "antd";
import type { ReactNode } from "react";
import {
  HTTP_VERSIONS,
  HTTP_VERSION_LABELS,
  TLS_PROTOCOLS,
  resolveRequestSettings,
  type RequestSettings,
  type TlsProtocol,
} from "@rabbitpost/shared";

interface Props {
  value: RequestSettings | undefined;
  onChange: (settings: RequestSettings) => void;
}

/** 右侧控件列宽度：与 Postman 一致，所有控件左对齐同一列 */
const CONTROL_WIDTH = 200;

/** “Default: Settings”提示：默认值来自全局设置，此处仅覆盖当前请求 */
function DefaultHint() {
  return (
    <Tooltip title="该项默认值取自全局 Settings，此处的修改仅作用于当前请求">
      <div style={{ marginTop: 4, fontSize: 12, color: "rgba(255,255,255,0.35)" }}>
        Default:{" "}
        <span style={{ textDecoration: "underline" }}>Settings</span>
      </div>
    </Tooltip>
  );
}

/** NEW 徽标（同 Postman 的新能力标记） */
function NewBadge() {
  return (
    <span
      style={{
        marginLeft: 8,
        padding: "0 5px",
        fontSize: 10,
        lineHeight: "16px",
        borderRadius: 3,
        color: "#b37feb",
        border: "1px solid #722ed1",
      }}
    >
      NEW
    </span>
  );
}

/** 单行设置：左侧标题 + 说明，右侧控件（可带默认值来源提示） */
function SettingRow({
  title,
  description,
  control,
  badge,
  showDefaultHint,
}: {
  title: string;
  description: string;
  control: ReactNode;
  badge?: ReactNode;
  showDefaultHint?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 24, padding: "10px 0" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center" }}>
          {title}
          {badge}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {description}
        </Typography.Text>
      </div>
      <div style={{ width: CONTROL_WIDTH, flexShrink: 0 }}>
        {control}
        {showDefaultHint ? <DefaultHint /> : null}
      </div>
    </div>
  );
}

/** 开关控件：开关 + ON / OFF 文案（同 Postman） */
function ToggleControl({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Switch size="small" checked={checked} onChange={onChange} />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {checked ? "ON" : "OFF"}
      </Typography.Text>
    </div>
  );
}

/**
 * Postman 风格的请求 Settings 面板：每行「标题 + 行为说明」对应右侧控件。
 * 说明文案如实描述执行时的实际行为，缺省值统一取自 shared 的 DEFAULT_REQUEST_SETTINGS。
 */
export default function RequestSettingsEditor({ value, onChange }: Props) {
  const settings = resolveRequestSettings(value);

  /** 合并写入单个设置项 */
  function set(part: RequestSettings) {
    onChange({ ...value, ...part });
  }

  return (
    <div style={{ maxWidth: 900 }}>
      <SettingRow
        title="HTTP version"
        badge={<NewBadge />}
        description="选择发送请求使用的 HTTP 版本。Auto 与 HTTP/1.x 均按 HTTP/1.1 发送，HTTP/2 直接以 h2 连接。"
        showDefaultHint
        control={
          <Select
            size="small"
            style={{ width: "100%" }}
            value={settings.httpVersion}
            options={HTTP_VERSIONS.map((v) => ({
              value: v,
              label: HTTP_VERSION_LABELS[v],
            }))}
            onChange={(httpVersion) => set({ httpVersion })}
          />
        }
      />
      <SettingRow
        title="Enable SSL certificate verification"
        description="发送请求时校验服务端 SSL 证书，校验失败则中止请求。"
        showDefaultHint
        control={
          <ToggleControl
            checked={settings.verifySsl}
            onChange={(verifySsl) => set({ verifySsl })}
          />
        }
      />
      <SettingRow
        title="Automatically follow redirects"
        description="自动跟随 HTTP 3xx 重定向；关闭后原样返回重定向响应。"
        showDefaultHint
        control={
          <ToggleControl
            checked={settings.followRedirects}
            onChange={(followRedirects) => set({ followRedirects })}
          />
        }
      />
      <SettingRow
        title="Follow original HTTP Method"
        description="重定向时沿用原 HTTP 方法，而非默认对 301/302/303 改用 GET。"
        control={
          <ToggleControl
            checked={settings.followOriginalHttpMethod}
            onChange={(followOriginalHttpMethod) => set({ followOriginalHttpMethod })}
          />
        }
      />
      <SettingRow
        title="Follow Authorization header"
        description="重定向到不同主机时保留 Authorization 头；关闭时跨主机会丢弃该头。"
        control={
          <ToggleControl
            checked={settings.followAuthorizationHeader}
            onChange={(followAuthorizationHeader) => set({ followAuthorizationHeader })}
          />
        }
      />
      <SettingRow
        title="Remove referer header on redirect"
        description="重定向时移除 Referer 头；关闭时会把上一跳 URL 写入 Referer。"
        control={
          <ToggleControl
            checked={settings.removeRefererOnRedirect}
            onChange={(removeRefererOnRedirect) => set({ removeRefererOnRedirect })}
          />
        }
      />
      <SettingRow
        title="Enable strict HTTP parser"
        description="严格解析响应，拒绝含非法 HTTP header 的响应；关闭时宽松解析。"
        control={
          <ToggleControl
            checked={settings.strictHttpParser}
            onChange={(strictHttpParser) => set({ strictHttpParser })}
          />
        }
      />
      <SettingRow
        title="Encode URL automatically"
        description="对 URL 的 path、query 参数与认证字段做百分号编码；关闭时按原文发送。"
        control={
          <ToggleControl
            checked={settings.encodeUrl}
            onChange={(encodeUrl) => set({ encodeUrl })}
          />
        }
      />
      <SettingRow
        title="Disable cookie jar"
        description="本请求不使用 Cookie Jar：既不把已存 cookie 作为请求头带上，响应 Set-Cookie 也不写回。"
        showDefaultHint
        control={
          <ToggleControl
            checked={settings.disableCookieJar}
            onChange={(disableCookieJar) => set({ disableCookieJar })}
          />
        }
      />
      <SettingRow
        title="Use server cipher suite during handshake"
        description="握手时采用服务端的 cipher suite 顺序，而非客户端顺序。"
        control={
          <ToggleControl
            checked={settings.useServerCipherSuite}
            onChange={(useServerCipherSuite) => set({ useServerCipherSuite })}
          />
        }
      />
      <SettingRow
        title="Maximum number of redirects"
        description="限制最多跟随的重定向次数，超过则报错中止。"
        control={
          <InputNumber
            size="small"
            min={0}
            precision={0}
            style={{ width: "100%" }}
            value={settings.maxRedirects}
            onChange={(maxRedirects) =>
              set({ maxRedirects: maxRedirects ?? undefined })
            }
          />
        }
      />
      <SettingRow
        title="TLS/SSL protocols disabled during handshake"
        description="指定握手时禁用的 SSL / TLS 协议版本，其余版本保持启用。"
        control={
          <Select<TlsProtocol[]>
            size="small"
            mode="multiple"
            allowClear
            style={{ width: "100%" }}
            placeholder="选择要禁用的协议"
            value={settings.disabledTlsProtocols}
            options={TLS_PROTOCOLS.map((p) => ({ value: p, label: p }))}
            onChange={(disabledTlsProtocols) => set({ disabledTlsProtocols })}
          />
        }
      />
      <SettingRow
        title="Cipher suite selection"
        description="建立安全连接时使用的 cipher suite 顺序（OpenSSL 名称，逗号 / 空格 / 换行分隔）。"
        control={
          <Input.TextArea
            className="code-font"
            autoSize={{ minRows: 4, maxRows: 8 }}
            placeholder="Enter cipher suites"
            value={settings.cipherSuites}
            onChange={(e) => set({ cipherSuites: e.target.value })}
          />
        }
      />
      <SettingRow
        title="Request timeout in ms"
        description="请求超时毫秒数（含重定向全过程），0 表示不超时。"
        control={
          <InputNumber
            size="small"
            min={0}
            step={1000}
            precision={0}
            style={{ width: "100%" }}
            value={settings.timeoutMs}
            onChange={(timeoutMs) => set({ timeoutMs: timeoutMs ?? undefined })}
          />
        }
      />
    </div>
  );
}
