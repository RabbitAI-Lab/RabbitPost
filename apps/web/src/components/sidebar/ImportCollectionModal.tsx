import { InboxOutlined } from "@ant-design/icons";
import { App, Modal, Spin, Typography, Upload } from "antd";
import { useState } from "react";
import type {
  DigestAlgorithm,
  HttpMethod,
  JwtAlgorithm,
  KeyValueItem,
  OAuth1SignatureMethod,
  OAuth2GrantType,
  RawLanguage,
  RequestAuth,
  RequestBody,
  RequestConfig,
  RequestScripts,
} from "@rabbitpost/shared";
import { HTTP_METHODS, RAW_LANGUAGES } from "@rabbitpost/shared";
import { collectionsApi } from "../../api";
import { useAppStore } from "../../stores/app";
import { newKvItem } from "../common/KeyValueEditor";

// ---------------------------------------------------------------------------
// Postman Collection v2/v2.1 宽松类型
// ---------------------------------------------------------------------------
interface PmKv {
  key?: string;
  value?: string;
  disabled?: boolean;
}

interface PmRequest {
  method?: string;
  url?:
    | string
    | {
        raw?: string;
        protocol?: string;
        host?: string[];
        path?: string[];
        query?: PmKv[];
      };
  header?: PmKv[];
  body?: {
    mode?: string;
    raw?: string;
    options?: { raw?: { language?: string } };
    urlencoded?: PmKv[];
    formdata?: PmKv[];
  };
  auth?: { type?: string } & Record<string, PmKv[] | string | undefined>;
}

interface PmItem {
  name?: string;
  item?: PmItem[];
  request?: PmRequest;
  event?: { listen?: string; script?: { exec?: string[] | string } }[];
}

interface PmCollection {
  info?: { name?: string; schema?: string };
  item?: PmItem[];
}

// ---------------------------------------------------------------------------
// Postman -> RequestConfig 转换
// ---------------------------------------------------------------------------
function toKv(list: PmKv[] | undefined): KeyValueItem[] {
  return (list ?? [])
    .filter((i) => typeof i.key === "string" && i.key !== "")
    .map((i) => newKvItem({ key: i.key as string, value: i.value ?? "", enabled: !i.disabled }));
}

function kvToMap(list: PmKv[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const i of list ?? []) {
    if (i.key != null) map[i.key] = i.value ?? "";
  }
  return map;
}

/**
 * Postman auth -> RequestAuth。只映射两边同名/等价的常见字段，
 * 未覆盖的字段留空由用户补填，不猜测语义。
 */
function convertAuth(auth: PmRequest["auth"]): RequestAuth {
  if (!auth?.type) return { type: "none" };
  /** 取某个 auth 子结构的 kv 映射 */
  const m = (key: string) => kvToMap(auth[key] as PmKv[] | undefined);
  const bool = (v: string | undefined) => v === "true";
  switch (auth.type) {
    case "basic": {
      const v = m("basic");
      return { type: "basic", basic: { username: v.username, password: v.password } };
    }
    case "bearer":
      return { type: "bearer", bearer: { token: m("bearer").token } };
    case "apikey": {
      const v = m("apikey");
      return {
        type: "api-key",
        apiKey: {
          key: v.key,
          value: v.value,
          in: v.in === "query" ? "query" : "header",
        },
      };
    }
    case "jwt": {
      const v = m("jwt");
      return {
        type: "jwt",
        jwt: {
          algorithm: (v.algorithm as JwtAlgorithm) || undefined,
          secret: v.secret,
          secretBase64Encoded: bool(v.isSecretBase64Encoded),
          privateKey: v.privateKey,
          payload: v.payload,
          jwtHeaders: v.header,
          addTokenTo: v.addTokenTo === "query" ? "query" : "header",
          headerPrefix: v.headerPrefix,
          queryParamKey: v.queryParamKey,
        },
      };
    }
    case "digest": {
      const v = m("digest");
      return {
        type: "digest",
        digest: {
          username: v.username,
          password: v.password,
          realm: v.realm,
          nonce: v.nonce,
          algorithm: (v.algorithm as DigestAlgorithm) || undefined,
          qop: v.qop === "auth-int" || v.qop === "auth" ? v.qop : undefined,
          nonceCount: v.nonceCount,
          clientNonce: v.clientNonce,
          opaque: v.opaque,
        },
      };
    }
    case "oauth1": {
      const v = m("oauth1");
      return {
        type: "oauth1",
        oauth1: {
          consumerKey: v.consumerKey,
          consumerSecret: v.consumerSecret,
          accessToken: v.token,
          tokenSecret: v.tokenSecret,
          signatureMethod: (v.signatureMethod as OAuth1SignatureMethod) || undefined,
          privateKey: v.privateKey,
          callbackUrl: v.callback,
          verifier: v.verifier,
          timestamp: v.timestamp,
          nonce: v.nonce,
          version: v.version,
          realm: v.realm,
          includeBodyHash: bool(v.includeBodyHash),
          addParamsTo: bool(v.addParamsToHeader) ? "header" : "query",
        },
      };
    }
    case "oauth2": {
      const v = m("oauth2");
      const grantMap: Record<string, OAuth2GrantType> = {
        authorization_code: "authorization_code",
        authorization_code_with_pkce: "authorization_code_pkce",
        implicit: "implicit",
        password_credentials: "password",
        client_credentials: "client_credentials",
      };
      return {
        type: "oauth2",
        oauth2: {
          grantType: grantMap[v.grant_type ?? ""],
          accessToken: v.accessToken,
          headerPrefix: v.headerPrefix,
          addTokenTo: v.addTokenTo === "queryParams" ? "query" : "header",
          callbackUrl: v.redirect_uri,
          authUrl: v.authUrl,
          accessTokenUrl: v.accessTokenUrl,
          clientId: v.clientId,
          clientSecret: v.clientSecret,
          scope: v.scope,
          state: v.state,
          username: v.username,
          password: v.password,
          clientAuthentication: v.client_authentication === "body" ? "body" : "header",
        },
      };
    }
    case "hawk": {
      const v = m("hawk");
      return {
        type: "hawk",
        hawk: {
          authId: v.authId,
          authKey: v.authKey,
          algorithm: v.algorithm === "sha1" ? "sha1" : "sha256",
          user: v.user,
          nonce: v.nonce,
          extraData: v.extraData,
          app: v.app,
          dlg: v.delegation,
          timestamp: v.timestamp,
          includePayloadHash: bool(v.includePayloadHash),
        },
      };
    }
    case "awsv4": {
      const v = m("awsv4");
      return {
        type: "aws-sigv4",
        awsSigv4: {
          accessKey: v.accessKey,
          secretKey: v.secretKey,
          region: v.region,
          service: v.service,
          sessionToken: v.sessionToken,
        },
      };
    }
    case "ntlm": {
      const v = m("ntlm");
      return {
        type: "ntlm",
        ntlm: {
          username: v.username,
          password: v.password,
          domain: v.domain,
          workstation: v.workstation,
          disableRetryRequest: bool(v.disableRetryRequest),
        },
      };
    }
    case "edgegrid": {
      const v = m("edgegrid");
      return {
        type: "edgegrid",
        edgegrid: {
          accessToken: v.accessToken,
          clientToken: v.clientToken,
          clientSecret: v.clientSecret,
          nonce: v.nonce,
          timestamp: v.timestamp,
          baseUri: v.baseURL ?? v.baseUri,
          headersToSign: v.headersToSign,
        },
      };
    }
    case "asap": {
      const v = m("asap");
      return {
        type: "asap",
        asap: {
          algorithm: (v.alg as JwtAlgorithm) || undefined,
          kid: v.kid,
          issuer: v.iss,
          audience: v.aud,
          subject: v.sub,
          additionalClaims: v.claims,
          privateKey: v.privateKey,
          expirySeconds: v.exp,
          tokenId: v.jti,
        },
      };
    }
    default:
      return { type: "none" };
  }
}

function convertBody(body: PmRequest["body"]): RequestBody {
  switch (body?.mode) {
    case "raw": {
      const lang = body.options?.raw?.language;
      const rawLanguage: RawLanguage =
        lang && (RAW_LANGUAGES as readonly string[]).includes(lang)
          ? (lang as RawLanguage)
          : "json";
      return { type: "raw", raw: body.raw ?? "", rawLanguage };
    }
    case "urlencoded":
      return { type: "x-www-form-urlencoded", urlencoded: toKv(body.urlencoded) };
    case "formdata":
      return { type: "form-data", formData: toKv(body.formdata) };
    default:
      return { type: "none", rawLanguage: "json" };
  }
}

function convertScripts(events: PmItem["event"]): RequestScripts {
  const pick = (listen: string): string | undefined => {
    const exec = (events ?? []).find((e) => e.listen === listen)?.script?.exec;
    if (Array.isArray(exec)) return exec.join("\n");
    return typeof exec === "string" ? exec : undefined;
  };
  return { preRequest: pick("prerequest"), test: pick("test") };
}

function convertRequest(req: PmRequest, events: PmItem["event"]): RequestConfig {
  const method: HttpMethod = (HTTP_METHODS as readonly string[]).includes(
    (req.method ?? "").toUpperCase(),
  )
    ? ((req.method as string).toUpperCase() as HttpMethod)
    : "GET";

  let url = "";
  let params: KeyValueItem[] = [];
  if (typeof req.url === "string") {
    url = req.url;
  } else if (req.url) {
    if (req.url.raw) {
      url = req.url.raw;
    } else {
      const host = (req.url.host ?? []).join(".");
      const path = (req.url.path ?? []).join("/");
      const proto = req.url.protocol ? `${req.url.protocol}://` : "";
      url = `${proto}${host}${path ? `/${path}` : ""}`;
    }
    params = toKv(req.url.query);
  }

  return {
    method,
    url,
    params,
    headers: toKv(req.header),
    body: convertBody(req.body),
    auth: convertAuth(req.auth),
    scripts: convertScripts(events),
  };
}

/** 递归创建 folder/request，返回导入的请求数 */
async function importItems(
  collectionId: string,
  items: PmItem[],
  parentId: string | null,
): Promise<number> {
  let count = 0;
  for (const it of items) {
    if (Array.isArray(it.item)) {
      const folder = await collectionsApi.createItem(collectionId, {
        parentId,
        type: "folder",
        name: it.name?.trim() || "Folder",
      });
      count += await importItems(collectionId, it.item, folder.id);
    } else if (it.request) {
      const created = await collectionsApi.createItem(collectionId, {
        parentId,
        type: "request",
        name: it.name?.trim() || "Request",
      });
      await collectionsApi.updateItem(created.id, {
        request: convertRequest(it.request, it.event),
      });
      count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ImportCollectionModal({ open, onClose }: Props) {
  const { message } = App.useApp();
  const currentWorkspaceId = useAppStore((s) => s.currentWorkspaceId);
  const refreshCollections = useAppStore((s) => s.refreshCollections);
  const [importing, setImporting] = useState(false);

  const handleFile = async (file: File) => {
    if (!currentWorkspaceId) return;

    let parsed: PmCollection;
    try {
      parsed = JSON.parse(await file.text()) as PmCollection;
    } catch (e) {
      message.error(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const name = parsed.info?.name?.trim();
    if (!name || !Array.isArray(parsed.item)) {
      message.error("不是有效的 Postman Collection 文件（缺少 info.name 或 item）");
      return;
    }

    setImporting(true);
    try {
      const col = await collectionsApi.create(currentWorkspaceId, name);
      const count = await importItems(col.id, parsed.item as PmItem[], null);
      await refreshCollections();
      message.success(`已导入「${name}」（${count} 个请求）`);
      onClose();
    } catch (e) {
      // 导入中途失败：错误原文透传，已创建的部分保留
      message.error(e instanceof Error ? e.message : String(e));
      await refreshCollections();
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      title="导入 Collection"
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
    >
      <Spin spinning={importing} description="正在导入…">
        <Upload.Dragger
          accept=".json,application/json"
          maxCount={1}
          showUploadList={false}
          disabled={importing}
          beforeUpload={(file) => {
            void handleFile(file);
            return false; // 阻止 antd 自动上传，本地解析
          }}
        >
          <p style={{ margin: "8px 0" }}>
            <InboxOutlined style={{ fontSize: 36, color: "#ff6c37" }} />
          </p>
          <p style={{ fontSize: 14 }}>点击选择或拖拽 JSON 文件到此处</p>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            支持 Postman Collection v2 / v2.1 导出格式
          </Typography.Text>
        </Upload.Dragger>
      </Spin>
    </Modal>
  );
}
