import {
  ArrowLeftOutlined,
  CloseOutlined,
  DeleteOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { App, Button, Empty, Input, Modal, Typography } from "antd";
import { useState } from "react";
import {
  normalizeDomainInput,
  parseRawCookie,
  useCookiesStore,
  type JarDomain,
} from "../../stores/cookies";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** 新增 cookie 的默认原始串（同 Postman） */
function defaultCookieRaw(domain: JarDomain): string {
  const names = new Set(
    domain.cookies.map((c) => parseRawCookie(c.raw)?.name ?? ""),
  );
  let n = domain.cookies.length + 1;
  while (names.has(`Cookie_${n}`)) n += 1;
  return `Cookie_${n}=value; Path=/; Expires=Tue, 19 Jan 2038 03:14:07 GMT;`;
}

/** 单个域名卡片：cookie chips + Add cookie + 原始串内联编辑 */
function DomainCard({ domain }: { domain: JarDomain }) {
  const { message } = App.useApp();
  const { removeDomain, upsertCookie, removeCookie } = useCookiesStore();
  // 正在编辑的 cookie id；"new" 表示新增
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const startEdit = (id: string | null, raw: string) => {
    setEditingId(id ?? "new");
    setEditText(raw);
  };

  const saveEdit = () => {
    const parsed = parseRawCookie(editText);
    if (!parsed) {
      message.error("Cookie 格式非法，需为 name=value; Attr=... 形式");
      return;
    }
    upsertCookie(domain.domain, editingId === "new" ? null : editingId, editText);
    setEditingId(null);
  };

  return (
    <div
      style={{
        border: "1px solid var(--ant-color-border-secondary, #333)",
        borderRadius: 8,
        padding: "10px 12px",
        marginBottom: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Typography.Text strong>{domain.domain}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {domain.cookies.length} cookie{domain.cookies.length === 1 ? "" : "s"}
        </Typography.Text>
        <div style={{ flex: 1 }} />
        <Button
          type="text"
          size="small"
          icon={<DeleteOutlined />}
          onClick={() => removeDomain(domain.domain)}
        />
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginTop: 8,
        }}
      >
        {domain.cookies.map((c) => {
          const name = parseRawCookie(c.raw)?.name ?? "(invalid)";
          return (
            <span
              key={c.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                border: "1px solid var(--ant-color-border, #444)",
                borderRadius: 6,
                padding: "2px 8px",
                fontSize: 12,
                cursor: "pointer",
              }}
              onClick={() => startEdit(c.id, c.raw)}
            >
              {name}
              <CloseOutlined
                style={{ fontSize: 10, opacity: 0.6 }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (editingId === c.id) setEditingId(null);
                  removeCookie(domain.domain, c.id);
                }}
              />
            </span>
          );
        })}
        <Button
          size="small"
          type="dashed"
          icon={<PlusOutlined />}
          onClick={() => startEdit(null, defaultCookieRaw(domain))}
        >
          Add cookie
        </Button>
      </div>
      {editingId !== null && (
        <div style={{ marginTop: 8 }}>
          <Input.TextArea
            className="code-font"
            autoSize={{ minRows: 2, maxRows: 6 }}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <Button type="primary" size="small" onClick={saveEdit}>
              Save
            </Button>
            <Button size="small" onClick={() => setEditingId(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Domains allowlist 子视图（同 Postman：脚本可编程访问 cookie 的域名白名单） */
function AllowlistView({ onBack }: { onBack: () => void }) {
  const { allowlist, addAllowlistDomain, removeAllowlistDomain } =
    useCookiesStore();
  const [input, setInput] = useState("");

  const add = () => {
    const domain = normalizeDomainInput(input);
    if (!domain) return;
    addAllowlistDomain(domain);
    setInput("");
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={onBack} />
        <Typography.Text strong>Domains allowlist</Typography.Text>
      </div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        加入白名单的域名，其 Cookie 可被脚本通过 rp.cookies.jar() 编程读写。
      </Typography.Paragraph>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <Input
          placeholder="Type a domain name"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={add}
        />
        <Button onClick={add}>Add</Button>
      </div>
      {allowlist.length === 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          暂无白名单域名。
        </Typography.Text>
      ) : (
        allowlist.map((d) => (
          <div
            key={d}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              border: "1px solid var(--ant-color-border-secondary, #333)",
              borderRadius: 8,
              padding: "6px 12px",
              marginBottom: 8,
            }}
          >
            <Typography.Text>{d}</Typography.Text>
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined />}
              onClick={() => removeAllowlistDomain(d)}
            />
          </div>
        ))
      )}
    </div>
  );
}

/** Cookie 管理弹窗：Manage Cookies / Sync Cookies / Domains allowlist（同 Postman） */
export default function CookieManagerModal({ open, onClose }: Props) {
  const { modal } = App.useApp();
  const { domains, addDomain, clearAll } = useCookiesStore();
  const [view, setView] = useState<"manage" | "sync" | "allowlist">("manage");
  const [domainInput, setDomainInput] = useState("");

  const handleAddDomain = () => {
    const domain = normalizeDomainInput(domainInput);
    if (!domain) return;
    addDomain(domain);
    setDomainInput("");
  };

  /** 顶部 Manage / Sync 切换按钮（激活项带浅色背景，同 Postman） */
  const tabButton = (key: "manage" | "sync", label: string) => (
    <Button
      type="text"
      size="small"
      style={
        view === key
          ? { background: "rgba(128, 128, 128, 0.18)", fontWeight: 600 }
          : undefined
      }
      onClick={() => setView(key)}
    >
      {label}
    </Button>
  );

  return (
    <Modal
      title="Cookies"
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      destroyOnHidden
    >
      {view === "allowlist" ? (
        <AllowlistView onBack={() => setView("manage")} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", minHeight: 360 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {tabButton("manage", "Manage Cookies")}
            {tabButton("sync", "Sync Cookies")}
          </div>

          {view === "manage" ? (
            <>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <Input
                  placeholder="Type a domain name"
                  value={domainInput}
                  onChange={(e) => setDomainInput(e.target.value)}
                  onPressEnter={handleAddDomain}
                />
                <Button onClick={handleAddDomain}>Add domain</Button>
              </div>
              <div style={{ flex: 1, overflow: "auto" }}>
                {domains.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="暂无 Cookie。添加域名后即可管理其 Cookie；发送请求时响应的 Set-Cookie 也会自动保存到这里。"
                    style={{ marginTop: 48 }}
                  />
                ) : (
                  domains.map((d) => <DomainCard key={d.domain} domain={d} />)
                )}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginTop: 16,
                }}
              >
                <Button onClick={() => setView("allowlist")}>Domains allowlist</Button>
                <Button
                  type="link"
                  size="small"
                  disabled={domains.length === 0}
                  onClick={() =>
                    modal.confirm({
                      title: "Clear all cookies",
                      content: "将删除所有域名下的全部 Cookie，且不可恢复。",
                      okText: "清空",
                      okButtonProps: { danger: true },
                      cancelText: "取消",
                      onOk: clearAll,
                    })
                  }
                >
                  Clear all cookies
                </Button>
              </div>
            </>
          ) : (
            <div style={{ flex: 1, paddingTop: 24, textAlign: "center" }}>
              <Typography.Paragraph type="secondary">
                Sync Cookies 需配合浏览器扩展（Interceptor）实时同步浏览器 Cookie。
              </Typography.Paragraph>
              <Typography.Paragraph type="secondary">
                该能力暂未开放，敬请期待。
              </Typography.Paragraph>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
