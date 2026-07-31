import { Input, Select, Switch, Typography } from "antd";
import type { ReactNode } from "react";
import {
  AUTH_TYPES,
  AUTH_TYPE_LABELS,
  DIGEST_ALGORITHMS,
  HAWK_ALGORITHMS,
  JWT_ALGORITHMS,
  OAUTH1_SIGNATURE_METHODS,
  OAUTH2_GRANT_TYPES,
  normalizeRequestAuth,
  type AuthType,
  type RequestAuth,
} from "@rabbitpost/shared";
import VarInput from "../common/variable/VarInput";
import VarTextArea from "../common/variable/VarTextArea";

/** auth 中承载各类型配置的字段名（排除 type 与已废弃的扁平字段） */
type SectionKey =
  | "basic"
  | "bearer"
  | "jwt"
  | "digest"
  | "oauth1"
  | "oauth2"
  | "hawk"
  | "awsSigv4"
  | "ntlm"
  | "apiKey"
  | "edgegrid"
  | "asap";

/** 左侧说明文案：说明发送时的实际行为，未实现的能力如实说明 */
const AUTH_TYPE_HINTS: Record<AuthType, string> = {
  none: "该请求不携带任何认证信息。",
  basic: "发送请求时自动生成 Authorization: Basic 头。",
  bearer: "发送请求时自动生成 Authorization: Bearer <token> 头。",
  jwt: "发送请求时用所选算法签发 JWT，并注入 Header 或 Query 参数。",
  digest:
    "发送请求时自动完成摘要认证；Realm / Nonce 留空则先取服务端 401 挑战再重发。",
  oauth1: "按 OAuth 1.0 规范计算签名，注入 Authorization 头或 Query 参数。",
  oauth2:
    "发送请求时仅携带已填写的 Access Token；暂不支持自动走授权流程换取 Token。",
  hawk: "按 Hawk 规范计算 MAC，生成 Authorization: Hawk 头。",
  "aws-sigv4": "按 AWS Signature V4 签名请求（注入 Header 或生成预签名 Query）。",
  ntlm: "NTLM 需要多轮握手，当前执行器尚未实现，发送时会明确报错而非静默跳过。",
  "api-key": "把 Key / Value 添加到 Header 或 Query 参数。",
  edgegrid: "按 Akamai EG1-HMAC-SHA256 规范生成 Authorization 头。",
  asap: "用私钥签发 ASAP (Atlassian) JWT，以 Bearer 形式注入 Authorization 头。",
};

const DOC_URL =
  "https://learning.postman.com/docs/sending-requests/authorization/authorization-types/";

type FieldSpec =
  | {
      kind: "text" | "password" | "textarea";
      label: string;
      value: string;
      onChange: (v: string) => void;
      placeholder?: string;
    }
  | {
      kind: "select";
      label: string;
      value: string;
      onChange: (v: string) => void;
      options: { value: string; label: string }[];
    }
  | {
      kind: "switch";
      label: string;
      checked: boolean;
      onChange: (v: boolean) => void;
      hint?: string;
    };

/** 由字符串枚举生成 Select options（label 直接用值） */
function enumOptions(values: readonly string[]): { value: string; label: string }[] {
  return values.map((value) => ({ value, label: value }));
}

const IN_OPTIONS = [
  { value: "header", label: "Header" },
  { value: "query", label: "Query Params" },
];

interface Props {
  value: RequestAuth;
  onChange: (auth: RequestAuth) => void;
}

/**
 * Postman 风格 Authorization 面板：左侧选类型 + 行为说明，右侧按类型渲染字段。
 * 请求 / Collection / 文件夹级别的鉴权配置共用本组件。
 */
export default function AuthEditor({ value, onChange }: Props) {
  const auth = normalizeRequestAuth(value);

  /** 合并写入某个类型的配置段 */
  function set<K extends SectionKey>(
    section: K,
    part: Partial<NonNullable<RequestAuth[K]>>,
  ) {
    onChange({
      ...auth,
      [section]: { ...(auth[section] ?? {}), ...part },
    } as RequestAuth);
  }

  function read<K extends SectionKey>(section: K, field: string): unknown {
    return (auth[section] as Record<string, unknown> | undefined)?.[field];
  }

  /** 文本 / 密码 / 多行文本字段 */
  function text<K extends SectionKey>(
    section: K,
    field: keyof NonNullable<RequestAuth[K]> & string,
    label: string,
    opts?: { kind?: "text" | "password" | "textarea"; placeholder?: string },
  ): FieldSpec {
    return {
      kind: opts?.kind ?? "text",
      label,
      value: String(read(section, field) ?? ""),
      onChange: (v: string) =>
        set(section, { [field]: v } as Partial<NonNullable<RequestAuth[K]>>),
      placeholder: opts?.placeholder ?? label,
    };
  }

  /** 下拉字段；defaultValue 为未设置时的显示值 */
  function select<K extends SectionKey>(
    section: K,
    field: keyof NonNullable<RequestAuth[K]> & string,
    label: string,
    options: { value: string; label: string }[],
    defaultValue: string,
  ): FieldSpec {
    return {
      kind: "select",
      label,
      value: String(read(section, field) ?? defaultValue),
      onChange: (v) =>
        set(section, { [field]: v } as Partial<NonNullable<RequestAuth[K]>>),
      options,
    };
  }

  /** 开关字段 */
  function toggle<K extends SectionKey>(
    section: K,
    field: keyof NonNullable<RequestAuth[K]> & string,
    label: string,
    hint?: string,
  ): FieldSpec {
    return {
      kind: "switch",
      label,
      checked: read(section, field) === true,
      onChange: (v) =>
        set(section, { [field]: v } as Partial<NonNullable<RequestAuth[K]>>),
      hint,
    };
  }

  const fields: FieldSpec[] = (() => {
    switch (auth.type) {
      case "basic":
        return [
          text("basic", "username", "Username"),
          text("basic", "password", "Password", { kind: "password" }),
        ];

      case "bearer":
        return [text("bearer", "token", "Token")];

      case "jwt": {
        const algorithm = auth.jwt?.algorithm ?? "HS256";
        const addTo = auth.jwt?.addTokenTo ?? "header";
        return [
          select(
            "jwt",
            "algorithm",
            "Algorithm",
            enumOptions(JWT_ALGORITHMS),
            "HS256",
          ),
          ...(algorithm.startsWith("HS")
            ? [
                text("jwt", "secret", "Secret", { kind: "password" }),
                toggle("jwt", "secretBase64Encoded", "Secret Base64 encoded"),
              ]
            : [
                text("jwt", "privateKey", "Private Key", {
                  kind: "textarea",
                  placeholder: "-----BEGIN PRIVATE KEY-----",
                }),
              ]),
          text("jwt", "payload", "Payload", {
            kind: "textarea",
            placeholder: '{\n  "sub": "1234567890"\n}',
          }),
          select("jwt", "addTokenTo", "Add JWT token to", IN_OPTIONS, "header"),
          ...(addTo === "query"
            ? [
                text("jwt", "queryParamKey", "Query param key", {
                  placeholder: "token",
                }),
              ]
            : [
                text("jwt", "headerPrefix", "Request header prefix", {
                  placeholder: "Bearer",
                }),
              ]),
          text("jwt", "jwtHeaders", "JWT headers", {
            kind: "textarea",
            placeholder: '{\n  "kid": "key-1"\n}',
          }),
        ];
      }

      case "digest":
        return [
          text("digest", "username", "Username"),
          text("digest", "password", "Password", { kind: "password" }),
          text("digest", "realm", "Realm", { placeholder: "留空则取服务端挑战" }),
          text("digest", "nonce", "Nonce", { placeholder: "留空则取服务端挑战" }),
          select(
            "digest",
            "algorithm",
            "Algorithm",
            enumOptions(DIGEST_ALGORITHMS),
            "MD5",
          ),
          select(
            "digest",
            "qop",
            "qop",
            [
              { value: "", label: "（不使用）" },
              { value: "auth", label: "auth" },
              { value: "auth-int", label: "auth-int" },
            ],
            "",
          ),
          text("digest", "nonceCount", "Nonce Count", { placeholder: "00000001" }),
          text("digest", "clientNonce", "Client Nonce", { placeholder: "自动生成" }),
          text("digest", "opaque", "Opaque"),
        ];

      case "oauth1": {
        const method = auth.oauth1?.signatureMethod ?? "HMAC-SHA1";
        return [
          select(
            "oauth1",
            "signatureMethod",
            "Signature Method",
            enumOptions(OAUTH1_SIGNATURE_METHODS),
            "HMAC-SHA1",
          ),
          text("oauth1", "consumerKey", "Consumer Key"),
          text("oauth1", "consumerSecret", "Consumer Secret", { kind: "password" }),
          text("oauth1", "accessToken", "Access Token"),
          text("oauth1", "tokenSecret", "Token Secret", { kind: "password" }),
          ...(method.startsWith("RSA")
            ? [
                text("oauth1", "privateKey", "Private Key", {
                  kind: "textarea",
                  placeholder: "-----BEGIN RSA PRIVATE KEY-----",
                }),
              ]
            : []),
          text("oauth1", "callbackUrl", "Callback URL"),
          text("oauth1", "verifier", "Verifier"),
          text("oauth1", "timestamp", "Timestamp", { placeholder: "自动生成" }),
          text("oauth1", "nonce", "Nonce", { placeholder: "自动生成" }),
          text("oauth1", "version", "Version", { placeholder: "1.0" }),
          text("oauth1", "realm", "Realm"),
          toggle("oauth1", "includeBodyHash", "Include body hash"),
          select(
            "oauth1",
            "addParamsTo",
            "Add params to",
            IN_OPTIONS,
            "header",
          ),
        ];
      }

      case "oauth2": {
        const grant = auth.oauth2?.grantType ?? "authorization_code";
        const addTo = auth.oauth2?.addTokenTo ?? "header";
        const needsAuthUrl =
          grant === "authorization_code" ||
          grant === "authorization_code_pkce" ||
          grant === "implicit";
        const needsTokenUrl = grant !== "implicit";
        const needsClientSecret =
          grant !== "implicit" && grant !== "authorization_code_pkce";
        return [
          text("oauth2", "accessToken", "Access Token"),
          select("oauth2", "addTokenTo", "Add token to", IN_OPTIONS, "header"),
          ...(addTo === "header"
            ? [
                text("oauth2", "headerPrefix", "Header Prefix", {
                  placeholder: "Bearer",
                }),
              ]
            : []),
          select(
            "oauth2",
            "grantType",
            "Grant Type",
            OAUTH2_GRANT_TYPES.map((value) => ({
              value,
              label:
                value === "authorization_code_pkce"
                  ? "Authorization Code (With PKCE)"
                  : value
                      .split("_")
                      .map((w) => w[0]!.toUpperCase() + w.slice(1))
                      .join(" "),
            })),
            "authorization_code",
          ),
          ...(needsAuthUrl
            ? [
                text("oauth2", "callbackUrl", "Callback URL"),
                text("oauth2", "authUrl", "Auth URL"),
              ]
            : []),
          ...(needsTokenUrl ? [text("oauth2", "accessTokenUrl", "Access Token URL")] : []),
          text("oauth2", "clientId", "Client ID"),
          ...(needsClientSecret
            ? [text("oauth2", "clientSecret", "Client Secret", { kind: "password" })]
            : []),
          ...(grant === "password"
            ? [
                text("oauth2", "username", "Username"),
                text("oauth2", "password", "Password", { kind: "password" }),
              ]
            : []),
          text("oauth2", "scope", "Scope", { placeholder: "e.g. read:org" }),
          text("oauth2", "state", "State"),
          select(
            "oauth2",
            "clientAuthentication",
            "Client Authentication",
            [
              { value: "header", label: "Send as Basic Auth header" },
              { value: "body", label: "Send client credentials in body" },
            ],
            "header",
          ),
        ];
      }

      case "hawk":
        return [
          text("hawk", "authId", "Hawk Auth ID"),
          text("hawk", "authKey", "Hawk Auth Key", { kind: "password" }),
          select(
            "hawk",
            "algorithm",
            "Algorithm",
            enumOptions(HAWK_ALGORITHMS),
            "sha256",
          ),
          text("hawk", "user", "User"),
          text("hawk", "nonce", "Nonce", { placeholder: "自动生成" }),
          text("hawk", "extraData", "ext"),
          text("hawk", "app", "app"),
          text("hawk", "dlg", "dlg"),
          text("hawk", "timestamp", "Timestamp", { placeholder: "自动生成" }),
          toggle("hawk", "includePayloadHash", "Include payload hash"),
        ];

      case "aws-sigv4":
        return [
          text("awsSigv4", "accessKey", "Access Key"),
          text("awsSigv4", "secretKey", "Secret Key", { kind: "password" }),
          text("awsSigv4", "region", "AWS Region", { placeholder: "us-east-1" }),
          text("awsSigv4", "service", "Service Name", { placeholder: "execute-api" }),
          text("awsSigv4", "sessionToken", "Session Token"),
          select(
            "awsSigv4",
            "addAuthDataTo",
            "Add authorization data to",
            IN_OPTIONS,
            "header",
          ),
        ];

      case "ntlm":
        return [
          text("ntlm", "username", "Username"),
          text("ntlm", "password", "Password", { kind: "password" }),
          text("ntlm", "domain", "Domain"),
          text("ntlm", "workstation", "Workstation"),
          toggle("ntlm", "disableRetryRequest", "Disable retrying the request"),
        ];

      case "api-key":
        return [
          text("apiKey", "key", "Key", { placeholder: "X-API-Key" }),
          text("apiKey", "value", "Value"),
          select("apiKey", "in", "Add to", IN_OPTIONS, "header"),
        ];

      case "edgegrid":
        return [
          text("edgegrid", "accessToken", "Access Token"),
          text("edgegrid", "clientToken", "Client Token"),
          text("edgegrid", "clientSecret", "Client Secret", { kind: "password" }),
          text("edgegrid", "nonce", "Nonce", { placeholder: "自动生成" }),
          text("edgegrid", "timestamp", "Timestamp", { placeholder: "自动生成" }),
          text("edgegrid", "baseUri", "Base URI"),
          text("edgegrid", "headersToSign", "Headers to Sign", {
            placeholder: "逗号分隔，如 Content-Type,Accept",
          }),
        ];

      case "asap":
        return [
          select(
            "asap",
            "algorithm",
            "Algorithm",
            enumOptions(JWT_ALGORITHMS.filter((a) => !a.startsWith("HS"))),
            "RS256",
          ),
          text("asap", "kid", "Key ID (kid)"),
          text("asap", "issuer", "Issuer (iss)"),
          text("asap", "audience", "Audience (aud)", { placeholder: "多个用逗号分隔" }),
          text("asap", "subject", "Subject (sub)", { placeholder: "缺省取 Issuer" }),
          text("asap", "expirySeconds", "Expiry (exp, 秒)", { placeholder: "3600" }),
          text("asap", "tokenId", "Token ID (jti)", { placeholder: "自动生成" }),
          text("asap", "additionalClaims", "Additional Claims", {
            kind: "textarea",
            placeholder: '{\n  "custom": "value"\n}',
          }),
          text("asap", "privateKey", "Private Key", {
            kind: "textarea",
            placeholder: "-----BEGIN PRIVATE KEY-----",
          }),
        ];

      default:
        return [];
    }
  })();

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* 左列：Auth Type + 行为说明 */}
      <div
        style={{
          width: 260,
          flexShrink: 0,
          paddingRight: 16,
          borderRight: "1px solid #f0f0f0",
        }}
      >
        <Typography.Text
          type="secondary"
          style={{ fontSize: 12, display: "block", marginBottom: 4 }}
        >
          Auth Type
        </Typography.Text>
        <Select
          size="small"
          style={{ width: "100%" }}
          value={auth.type}
          options={AUTH_TYPES.map((value) => ({
            value,
            label: AUTH_TYPE_LABELS[value],
          }))}
          onChange={(type) => onChange({ ...auth, type })}
        />
        <Typography.Paragraph
          type="secondary"
          style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}
        >
          {AUTH_TYPE_HINTS[auth.type]}
          {auth.type !== "none" && (
            <>
              {" "}
              <Typography.Link href={DOC_URL} target="_blank" style={{ fontSize: 12 }}>
                了解更多
              </Typography.Link>
            </>
          )}
        </Typography.Paragraph>
        {auth.type !== "none" && (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, display: "block", marginTop: 8 }}
          >
            所有字段均支持 {"{{variable}}"} 变量。
          </Typography.Text>
        )}
      </div>

      {/* 右列：类型对应的字段 */}
      <div style={{ flex: 1, minWidth: 0, paddingLeft: 16, overflow: "auto" }}>
        {fields.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            该请求不需要填写认证信息。
          </Typography.Text>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(120px, 220px) minmax(0, 1fr)",
              columnGap: 16,
              rowGap: 8,
              alignItems: "start",
              maxWidth: 900,
            }}
          >
            {fields.map((field) => (
              <FieldRow key={field.label} field={field} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 单个字段行：左标签、右控件（text / textarea 支持 {{var}} 高亮；密码框为掩码文本不做高亮） */
function FieldRow({ field }: { field: FieldSpec }) {
  let control: ReactNode;
  switch (field.kind) {
    case "password":
      control = (
        <Input.Password
          size="small"
          placeholder={field.placeholder}
          value={field.value}
          onChange={(e) => field.onChange(e.target.value)}
        />
      );
      break;
    case "textarea":
      control = (
        <VarTextArea
          className="code-font"
          autoSize={{ minRows: 4, maxRows: 12 }}
          placeholder={field.placeholder}
          value={field.value}
          onChange={field.onChange}
        />
      );
      break;
    case "select":
      control = (
        <Select
          size="small"
          style={{ width: "100%", maxWidth: 280 }}
          value={field.value}
          options={field.options}
          onChange={(v) => field.onChange(v)}
        />
      );
      break;
    case "switch":
      control = (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Switch size="small" checked={field.checked} onChange={field.onChange} />
          {field.hint && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {field.hint}
            </Typography.Text>
          )}
        </span>
      );
      break;
    default:
      control = (
        <VarInput
          size="small"
          placeholder={field.placeholder}
          value={field.value}
          onChange={field.onChange}
        />
      );
  }

  return (
    <>
      <div style={{ fontSize: 13, paddingTop: 4, minWidth: 0 }}>{field.label}</div>
      <div style={{ minWidth: 0 }}>{control}</div>
    </>
  );
}
