import {
  CloseOutlined,
  DownOutlined,
  EditOutlined,
  EyeOutlined,
  ReloadOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import {
  App,
  Button,
  Input,
  Radio,
  Segmented,
  Select,
  Space,
  Tabs,
  Typography,
  Upload,
} from "antd";
import { useEffect, useState } from "react";
import type { KeyValueItem } from "@rabbitpost/shared";
import { isAuthConfigured } from "@rabbitpost/shared";
import { useCasesStore } from "../../stores/cases";
import { useTabsStore, type RequestTab } from "../../stores/tabs";
import KeyValueEditor, { newKvItem } from "../common/KeyValueEditor";
import MarkdownEditor from "../common/MarkdownEditor";
import VarTextArea from "../common/variable/VarTextArea";
import AuthEditor from "./AuthEditor";
import CasesPanel from "./CasesPanel";
import CookieManagerModal from "./CookieManagerModal";
import RequestSettingsEditor from "./RequestSettingsEditor";
import ScriptSnippets from "./ScriptSnippets";

interface Props {
  tab: RequestTab;
}

/** Tab 标签：可带已启用条目数或“已配置”绿点（同 Postman） */
function TabLabel({
  text,
  count,
  dot,
}: {
  text: string;
  count?: number;
  dot?: boolean;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      {text}
      {count ? (
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {count}
        </Typography.Text>
      ) : null}
      {dot ? (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "#52c41a",
          }}
        />
      ) : null}
    </span>
  );
}

/** 已启用条目数 */
function enabledCount(items: KeyValueItem[]): number {
  return items.filter((i) => i.enabled && i.key).length;
}

/** 将参数列表序列化为 Bulk Editor 的 JSON 文本 */
function paramsToJson(items: KeyValueItem[]): string {
  return JSON.stringify(
    items.map(({ key, value, description, enabled, type }) => ({
      key,
      value,
      ...(description ? { description } : {}),
      ...(enabled === false ? { enabled } : {}),
      ...(type === "file" ? { type } : {}),
    })),
    null,
    2,
  );
}

/** 解析 Bulk Editor 的 JSON 文本为参数列表；格式非法时抛出异常 */
function jsonToParams(text: string): KeyValueItem[] {
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => {
      const it = (entry ?? {}) as Partial<KeyValueItem>;
      return newKvItem({
        key: String(it.key ?? ""),
        value: String(it.value ?? ""),
        description: it.description ? String(it.description) : undefined,
        enabled: it.enabled !== false,
        ...(it.type === "file" ? { type: "file" as const } : {}),
      });
    });
  }
  // 也支持 {"key": "value"} 形式的对象写法
  if (parsed !== null && typeof parsed === "object") {
    return Object.entries(parsed as Record<string, unknown>).map(([key, value]) =>
      newKvItem({ key, value: String(value ?? "") }),
    );
  }
  throw new Error("JSON 需为数组或对象");
}

/** 简易 XML / HTML 格式化：标签间换行 + 两格缩进 */
function formatMarkup(source: string): string {
  const lines = source
    .replace(/>\s+</g, "><")
    .trim()
    .replace(/></g, ">\n<")
    .split("\n");
  let indent = 0;
  return lines
    .map((line) => {
      const isClosing = /^<\//.test(line);
      // 自闭合标签 / 声明注释 / 同行开闭（<a>text</a>）不增加缩进
      const isSelfContained =
        /\/>$/.test(line) || /^<[!?]/.test(line) || /<\/[^>]+>$/.test(line);
      if (isClosing) indent = Math.max(indent - 1, 0);
      const out = "  ".repeat(indent) + line;
      if (!isClosing && !isSelfContained && /^</.test(line)) indent += 1;
      return out;
    })
    .join("\n");
}

/** 带标题行 + Bulk Editor 切换的 Key-Value 编辑区（Params / Headers 共用） */
function BulkKvSection({
  title,
  items,
  onChange,
}: {
  title: string;
  items: KeyValueItem[];
  onChange: (items: KeyValueItem[]) => void;
}) {
  const { message } = App.useApp();
  const [bulk, setBulk] = useState(false);
  const [bulkText, setBulkText] = useState("");

  const toggleBulk = () => {
    if (!bulk) {
      setBulkText(paramsToJson(items));
      setBulk(true);
      return;
    }
    // 切回表格：JSON 非法时阻断并提示
    try {
      onChange(jsonToParams(bulkText));
      setBulk(false);
    } catch (e) {
      message.error(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {title}
        </Typography.Text>
        <Button type="link" size="small" onClick={toggleBulk}>
          {bulk ? "Key-Value Editor" : "Bulk Editor"}
        </Button>
      </div>
      {bulk ? (
        <VarTextArea
          className="code-font"
          autoSize={{ minRows: 8, maxRows: 24 }}
          value={bulkText}
          placeholder='[{"key": "page", "value": "1", "description": "页码"}]'
          onChange={(text) => {
            setBulkText(text);
            // JSON 合法时实时同步回列表
            try {
              onChange(jsonToParams(text));
            } catch {
              /* 编辑中的非法 JSON 先不同步 */
            }
          }}
        />
      ) : (
        <KeyValueEditor items={items} onChange={onChange} showDescription highlightVars />
      )}
    </div>
  );
}

/** 请求配置区 Tabs：Docs / Params / Authorization / Headers / Body / Scripts / Settings */
export default function RequestConfigTabs({ tab }: Props) {
  const { message } = App.useApp();
  const updateConfig = useTabsStore((s) => s.updateConfig);
  const patch = updateConfig;
  // Cases tab：仅已保存的接口（非草稿、非用例 tab、非场景步骤 tab）显示；提前加载以保证徽标计数准确
  const showCases = !!tab.itemId && !tab.caseId && !tab.stepId;
  const casesCount = useCasesStore((s) =>
    showCases ? (s.byItemId[tab.itemId!]?.length ?? 0) : 0,
  );
  const loadCases = useCasesStore((s) => s.load);
  useEffect(() => {
    if (showCases) void loadCases(tab.itemId!);
  }, [showCases, tab.itemId, loadCases]);
  // Cookie 管理弹窗
  const [cookiesOpen, setCookiesOpen] = useState(false);
  // Docs 编辑 / 预览模式；默认编辑
  const [docsMode, setDocsMode] = useState<"edit" | "preview">("edit");
  // form-data / x-www-form-urlencoded 的 Bulk Editor 状态（同 Params）
  const [bodyBulk, setBodyBulk] = useState(false);
  const [bodyBulkText, setBodyBulkText] = useState("");
  // 当前 body 类型对应的 KV 字段名
  const bodyKvField =
    tab.config.body.type === "form-data" ? ("formData" as const) : ("urlencoded" as const);

  /** 点击 Snippet：把片段代码追加到对应脚本末尾 */
  const appendScript = (field: "preRequest" | "test", code: string) => {
    const current = tab.config.scripts[field] ?? "";
    const next = current.trim() ? `${current.replace(/\s+$/, "")}\n${code}\n` : `${code}\n`;
    patch(tab.key, { scripts: { ...tab.config.scripts, [field]: next } });
  };

  const toggleBodyBulk = () => {
    if (!bodyBulk) {
      setBodyBulkText(paramsToJson(tab.config.body[bodyKvField] ?? []));
      setBodyBulk(true);
      return;
    }
    // 切回表格：JSON 非法时阻断并提示
    try {
      patch(tab.key, {
        body: { ...tab.config.body, [bodyKvField]: jsonToParams(bodyBulkText) },
      });
      setBodyBulk(false);
    } catch (e) {
      message.error(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** form-data / urlencoded 共用的 Bulk 编辑 textarea */
  const bodyBulkTextArea = (
    <VarTextArea
      className="code-font"
      autoSize={{ minRows: 8, maxRows: 24 }}
      value={bodyBulkText}
      placeholder='[{"key": "name", "value": "rabbit", "description": "名称"}]'
      onChange={(text) => {
        setBodyBulkText(text);
        // JSON 合法时实时同步回列表
        try {
          patch(tab.key, {
            body: { ...tab.config.body, [bodyKvField]: jsonToParams(text) },
          });
        } catch {
          /* 编辑中的非法 JSON 先不同步 */
        }
      }}
    />
  );

  /** raw 内容按当前语言格式化 */
  const beautifyRaw = () => {
    const lang = tab.config.body.rawLanguage ?? "json";
    const raw = tab.config.body.raw ?? "";
    if (!raw.trim()) return;
    if (lang === "text" || lang === "javascript") {
      message.info("Text / JavaScript 暂不支持格式化");
      return;
    }
    try {
      const formatted =
        lang === "json"
          ? JSON.stringify(JSON.parse(raw), null, 2)
          : formatMarkup(raw);
      patch(tab.key, { body: { ...tab.config.body, raw: formatted } });
    } catch (e) {
      message.error(`格式化失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <Tabs
      size="small"
      className="pane-tabs"
      tabBarExtraContent={{
        right: (
          <>
            {/* Tab 行最右侧 Cookies 入口，同 Postman */}
            <Button type="link" size="small" onClick={() => setCookiesOpen(true)}>
              Cookies
            </Button>
            <CookieManagerModal
              open={cookiesOpen}
              onClose={() => setCookiesOpen(false)}
            />
          </>
        ),
      }}
      items={[
        {
          key: "docs",
          label: "Docs",
          children: (
            <div
              style={{
                height: "100%",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexShrink: 0,
                }}
              >
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  请求文档，支持 Markdown 语法，随请求一并保存。
                </Typography.Text>
                <Segmented
                  size="small"
                  value={docsMode}
                  onChange={(v) => setDocsMode(v as "edit" | "preview")}
                  options={[
                    { value: "edit", label: "编辑", icon: <EditOutlined /> },
                    { value: "preview", label: "预览", icon: <EyeOutlined /> },
                  ]}
                />
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <MarkdownEditor
                  initialValue={tab.config.docs ?? ""}
                  mode={docsMode}
                  onChange={(docs) => patch(tab.key, { docs })}
                />
              </div>
            </div>
          ),
        },
        {
          key: "params",
          label: <TabLabel text="Params" count={enabledCount(tab.config.params)} />,
          children: (
            <BulkKvSection
              title="Query Params"
              items={tab.config.params}
              onChange={(params) => patch(tab.key, { params })}
            />
          ),
        },
        {
          key: "auth",
          label: (
            <TabLabel text="Authorization" dot={isAuthConfigured(tab.config.auth)} />
          ),
          children: (
            <AuthEditor
              value={tab.config.auth}
              onChange={(auth) => patch(tab.key, { auth })}
            />
          ),
        },
        {
          key: "headers",
          label: <TabLabel text="Headers" count={enabledCount(tab.config.headers)} />,
          children: (
            <BulkKvSection
              title="Headers"
              items={tab.config.headers}
              onChange={(headers) => patch(tab.key, { headers })}
            />
          ),
        },
        {
          key: "body",
          label: <TabLabel text="Body" dot={tab.config.body.type !== "none"} />,
          children: (
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {/* Postman 风格圆形单选；顺序与 Postman 一致 */}
                  <Radio.Group
                    size="small"
                    value={tab.config.body.type}
                    onChange={(e) => {
                      setBodyBulk(false);
                      patch(tab.key, {
                        body: { ...tab.config.body, type: e.target.value },
                      });
                    }}
                  >
                    <Radio value="none">none</Radio>
                    <Radio value="form-data">form-data</Radio>
                    <Radio value="x-www-form-urlencoded">x-www-form-urlencoded</Radio>
                    <Radio value="raw">raw</Radio>
                    <Radio value="binary">binary</Radio>
                    <Radio value="graphql">GraphQL</Radio>
                  </Radio.Group>
                  {/* raw 时语言下拉紧跟单选组，同 Postman；胡萝卜橙高亮便于发现 */}
                  {tab.config.body.type === "raw" && (
                    <Select
                      size="small"
                      variant="borderless"
                      className="raw-lang-select"
                      value={tab.config.body.rawLanguage ?? "json"}
                      style={{ color: "#ff6c37" }}
                      popupMatchSelectWidth={false}
                      labelRender={(item) => (
                        <span style={{ color: "#ff6c37" }}>{item.label}</span>
                      )}
                      suffixIcon={<DownOutlined style={{ color: "#ff6c37" }} />}
                      options={[
                        { value: "text", label: "Text" },
                        { value: "javascript", label: "JavaScript" },
                        { value: "json", label: "JSON" },
                        { value: "html", label: "HTML" },
                        { value: "xml", label: "XML" },
                      ]}
                      onChange={(rawLanguage) =>
                        patch(tab.key, {
                          body: { ...tab.config.body, rawLanguage },
                        })
                      }
                    />
                  )}
                  {/* GraphQL 时 schema 获取方式下拉 + 刷新按钮，同 Postman */}
                  {tab.config.body.type === "graphql" && (
                    <>
                      <Select
                        size="small"
                        variant="borderless"
                        value={tab.config.body.graphqlSchemaMode ?? "auto"}
                        style={{ width: 110 }}
                        options={[
                          { value: "auto", label: "Auto Fetch" },
                          { value: "none", label: "No Schema" },
                        ]}
                        onChange={(graphqlSchemaMode) =>
                          patch(tab.key, {
                            body: { ...tab.config.body, graphqlSchemaMode },
                          })
                        }
                      />
                      <Button
                        type="text"
                        size="small"
                        icon={<ReloadOutlined />}
                        disabled={tab.config.body.graphqlSchemaMode === "none"}
                        onClick={() => message.info("Schema 获取暂未支持")}
                      />
                    </>
                  )}
                </div>
                {/* form-data / urlencoded 时右侧显示 Bulk Editor 切换，同 Params */}
                {(tab.config.body.type === "form-data" ||
                  tab.config.body.type === "x-www-form-urlencoded") && (
                  <Button type="link" size="small" onClick={toggleBodyBulk}>
                    {bodyBulk ? "Key-Value Editor" : "Bulk Editor"}
                  </Button>
                )}
                {/* raw 时右侧显示 Beautify 格式化按钮 */}
                {tab.config.body.type === "raw" && (
                  <Button type="link" size="small" onClick={beautifyRaw}>
                    Beautify
                  </Button>
                )}
              </div>

              {tab.config.body.type === "raw" && (
                <VarTextArea
                  className="code-font"
                  autoSize={{ minRows: 8, maxRows: 24 }}
                  placeholder='{"key": "value"}'
                  value={tab.config.body.raw ?? ""}
                  onChange={(raw) =>
                    patch(tab.key, {
                      body: { ...tab.config.body, raw },
                    })
                  }
                />
              )}
              {tab.config.body.type === "x-www-form-urlencoded" &&
                (bodyBulk ? (
                  bodyBulkTextArea
                ) : (
                  <KeyValueEditor
                    items={tab.config.body.urlencoded ?? []}
                    onChange={(urlencoded) =>
                      patch(tab.key, { body: { ...tab.config.body, urlencoded } })
                    }
                    showDescription
                    highlightVars
                  />
                ))}
              {tab.config.body.type === "form-data" &&
                (bodyBulk ? (
                  bodyBulkTextArea
                ) : (
                  <KeyValueEditor
                    items={tab.config.body.formData ?? []}
                    onChange={(formData) =>
                      patch(tab.key, { body: { ...tab.config.body, formData } })
                    }
                    showDescription
                    showKeyType
                    highlightVars
                  />
                ))}
              {tab.config.body.type === "binary" && (
                <Space>
                  {/* 选择文件后读为 base64 存入条目；阻止 antd 自动上传 */}
                  <Upload
                    showUploadList={false}
                    beforeUpload={(file) => {
                      const reader = new FileReader();
                      reader.onload = () => {
                        const result = String(reader.result ?? "");
                        const binaryBase64 = result.slice(result.indexOf(",") + 1);
                        patch(tab.key, {
                          body: {
                            ...tab.config.body,
                            binaryBase64,
                            binaryFileName: file.name,
                          },
                        });
                      };
                      reader.readAsDataURL(file);
                      return false;
                    }}
                  >
                    <Button size="small" icon={<UploadOutlined />}>
                      {tab.config.body.binaryFileName ?? "Select File"}
                    </Button>
                  </Upload>
                  {tab.config.body.binaryFileName && (
                    <Button
                      type="text"
                      size="small"
                      icon={<CloseOutlined />}
                      onClick={() =>
                        patch(tab.key, {
                          body: {
                            ...tab.config.body,
                            binaryBase64: undefined,
                            binaryFileName: undefined,
                          },
                        })
                      }
                    />
                  )}
                </Space>
              )}
              {tab.config.body.type === "graphql" && (
                <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
                  {/* 左右分栏：左 Query，右 Variables */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 12, display: "block", marginBottom: 4 }}
                    >
                      Query
                    </Typography.Text>
                    <VarTextArea
                      className="code-font"
                      autoSize={{ minRows: 10, maxRows: 24 }}
                      placeholder={"query {\n  field\n}"}
                      value={tab.config.body.graphqlQuery ?? ""}
                      onChange={(graphqlQuery) =>
                        patch(tab.key, {
                          body: { ...tab.config.body, graphqlQuery },
                        })
                      }
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 12, display: "block", marginBottom: 4 }}
                    >
                      GraphQL Variables
                    </Typography.Text>
                    <VarTextArea
                      className="code-font"
                      autoSize={{ minRows: 10, maxRows: 24 }}
                      placeholder='{"id": 1}'
                      value={tab.config.body.graphqlVariables ?? ""}
                      onChange={(graphqlVariables) =>
                        patch(tab.key, {
                          body: {
                            ...tab.config.body,
                            graphqlVariables,
                          },
                        })
                      }
                    />
                  </div>
                </div>
              )}
              {tab.config.body.type === "none" && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  该请求不携带 Body。
                </Typography.Text>
              )}
            </div>
          ),
        },
        {
          key: "scripts",
          label: (
            <TabLabel
              text="Scripts"
              dot={
                !!tab.config.scripts.preRequest?.trim() ||
                !!tab.config.scripts.test?.trim()
              }
            />
          ),
          children: (
            <Tabs
              size="small"
              tabPosition="left"
              className="scripts-tabs"
              items={[
                {
                  key: "pre",
                  label: "Pre-request",
                  children: (
                    <div style={{ display: "flex", gap: 12, height: "100%" }}>
                      <div
                        style={{
                          flex: 1,
                          minWidth: 0,
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                        }}
                      >
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {'脚本中请用 rp.environment.get("varName") 读写变量，{{}} 不会被替换'}
                        </Typography.Text>
                        <Input.TextArea
                          className="code-font"
                          style={{ flex: 1, minWidth: 0, resize: "none" }}
                          placeholder={'rp.environment.set("ts", Date.now());'}
                          value={tab.config.scripts.preRequest ?? ""}
                          onChange={(e) =>
                            patch(tab.key, {
                              scripts: { ...tab.config.scripts, preRequest: e.target.value },
                            })
                          }
                        />
                      </div>
                      <ScriptSnippets
                        phase="pre-request"
                        onInsert={(code) => appendScript("preRequest", code)}
                      />
                    </div>
                  ),
                },
                {
                  key: "test",
                  label: "Tests",
                  children: (
                    <div style={{ display: "flex", gap: 12, height: "100%" }}>
                      <div
                        style={{
                          flex: 1,
                          minWidth: 0,
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                        }}
                      >
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {'脚本中请用 rp.environment.get("varName") 读写变量，{{}} 不会被替换'}
                        </Typography.Text>
                        <Input.TextArea
                          className="code-font"
                          style={{ flex: 1, minWidth: 0, resize: "none" }}
                          placeholder={
                            'rp.test("status is 200", () => {\n  rp.response.to.have.status(200);\n});'
                          }
                          value={tab.config.scripts.test ?? ""}
                          onChange={(e) =>
                            patch(tab.key, {
                              scripts: { ...tab.config.scripts, test: e.target.value },
                            })
                          }
                        />
                      </div>
                      <ScriptSnippets
                        phase="test"
                        onInsert={(code) => appendScript("test", code)}
                      />
                    </div>
                  ),
                },
              ]}
            />
          ),
        },
        {
          key: "settings",
          label: "Settings",
          children: (
            <RequestSettingsEditor
              value={tab.config.settings}
              onChange={(settings) => patch(tab.key, { settings })}
            />
          ),
        },
        // 接口用例：用例 tab 自身与草稿不显示
        ...(showCases
          ? [
              {
                key: "cases",
                label: <TabLabel text="Cases" count={casesCount} />,
                children: <CasesPanel tab={tab} />,
              },
            ]
          : []),
      ]}
    />
  );
}
