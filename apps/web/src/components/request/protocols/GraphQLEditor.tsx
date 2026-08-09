import { ApiOutlined, ReloadOutlined, SendOutlined, StopOutlined } from "@ant-design/icons";
import { App, Button, Tabs, Tag, Tree, Typography, Splitter } from "antd";
import type { DataNode } from "antd/es/tree";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import { graphql as cmGraphql, updateSchema } from "cm6-graphql";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphQLSchema } from "graphql";
import { buildClientSchema, getIntrospectionQuery, isObjectType } from "graphql";
import { isAuthConfigured, substituteVariables } from "@rabbitpost/shared";
import { executeRequestConfig } from "../../../lib/execute";
import { useAppStore } from "../../../stores/app";
import { useTabsStore, type RequestTab } from "../../../stores/tabs";
import VarInput from "../../common/variable/VarInput";
import AuthEditor from "../AuthEditor";
import MessageLog from "../MessageLog";
import { HeadersSection } from "../RequestConfigTabs";
import ResponseViewer from "../ResponseViewer";
import { useRtConnection } from "./use-rt-connection";

interface Props {
  tab: RequestTab;
  /** 发送请求（沿用 HTTP 执行链路的 GraphQL-over-HTTP 分支） */
  onSend: () => void;
}

/** 从 GraphQLSchema 构建 Schema 文档树：Query / Mutation / Subscription 字段 + 全部自定义类型 */
function buildSchemaTree(schema: GraphQLSchema): DataNode[] {
  const opNode = (
    title: string,
    type: ReturnType<GraphQLSchema["getQueryType"]>,
  ): DataNode | null => {
    if (!type || !isObjectType(type)) return null;
    const fields: DataNode[] = Object.values(type.getFields()).map((f) => ({
      key: `${title}.${f.name}`,
      title: `${f.name}: ${String(f.type)}`,
    }));
    return {
      key: title,
      title,
      children: fields.length ? fields : undefined,
    };
  };
  const roots: DataNode[] = [
    opNode("Query", schema.getQueryType()),
    opNode("Mutation", schema.getMutationType()),
    opNode("Subscription", schema.getSubscriptionType()),
  ].filter((n) => n !== null);

  const builtins = new Set(["String", "Int", "Float", "Boolean", "ID"]);
  const types: DataNode[] = Object.values(schema.getTypeMap())
    .filter((t) => !t.name.startsWith("__") && !builtins.has(t.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t): DataNode => {
      if (isObjectType(t)) {
        const fields: DataNode[] = Object.values(t.getFields()).map((f) => ({
          key: `type.${t.name}.${f.name}`,
          title: `${f.name}: ${String(f.type)}`,
        }));
        return { key: `type.${t.name}`, title: t.name, children: fields };
      }
      return { key: `type.${t.name}`, title: `${t.name} (${t.astNode?.kind ?? "type"})` };
    });
  if (types.length) {
    roots.push({ key: "Types", title: `Types (${types.length})`, children: types });
  }
  return roots;
}

/**
 * GraphQL 协议编辑器（参考 Postman / Postwoman）：
 * - URL 栏固定 POST，发送走 GraphQL-over-HTTP（复用 executor 的 graphql body 分支）
 * - 配置区：Query（cm6-graphql 语法高亮 + schema 感知补全）/ Variables / Headers / Authorization / Schema 文档
 * - Schema 通过 introspection 查询经服务端代理拉取（规避 CORS），仅缓存在内存不持久化
 */
export default function GraphQLEditor({ tab, onSend }: Props) {
  const { message } = App.useApp();
  const { currentWorkspaceId, activeEnvironmentId, environments, collections, workspaces } =
    useAppStore();
  const updateConfig = useTabsStore((s) => s.updateConfig);
  const patch = updateConfig;

  const [schema, setSchema] = useState<GraphQLSchema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const cmRef = useRef<{ view?: Parameters<typeof updateSchema>[0] }>(null);

  // 兜底：进入 GraphQL 编辑器时保证 body 是 graphql 类型、方法为 POST
  useEffect(() => {
    if (tab.config.body.type !== "graphql" || tab.config.method !== "POST") {
      patch(tab.key, {
        method: "POST",
        body: { ...tab.config.body, type: "graphql" },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.key]);

  /** 拉取 introspection schema：构造一个临时 config 复用执行链路（服务端代发，规避 CORS） */
  const fetchSchema = useCallback(async () => {
    if (!currentWorkspaceId) {
      message.warning("请先选择 Workspace");
      return;
    }
    if (!tab.config.url.trim()) {
      message.warning("请输入 GraphQL Endpoint URL");
      return;
    }
    setSchemaLoading(true);
    setSchemaError(null);
    try {
      const result = await executeRequestConfig({
        workspaceId: currentWorkspaceId,
        environmentId: activeEnvironmentId,
        environments,
        name: `${tab.name} (introspection)`,
        config: {
          ...tab.config,
          method: "POST",
          body: {
            ...tab.config.body,
            type: "graphql",
            graphqlQuery: getIntrospectionQuery(),
            graphqlVariables: undefined,
          },
        },
        itemId: tab.itemId ?? undefined,
        collectionVariables: collections.find((c) => c.id === tab.collectionId)
          ?.variables,
        globalVariables: workspaces.find((w) => w.id === currentWorkspaceId)?.variables,
      });
      if (!result.ok || !result.bodyText) {
        throw new Error(result.error || `Introspection 失败（HTTP ${result.status ?? "?"}）`);
      }
      const payload = JSON.parse(result.bodyText) as {
        data?: Record<string, unknown>;
        errors?: { message: string }[];
      };
      if (!payload.data) {
        throw new Error(
          payload.errors?.[0]?.message ?? "响应中缺少 data，该端点可能未开启 introspection",
        );
      }
      const s = buildClientSchema(payload.data as never);
      setSchema(s);
      // 已挂载的 Query 编辑器热更新 schema（补全 / lint 立即生效）
      if (cmRef.current?.view) updateSchema(cmRef.current.view, s);
      message.success("Schema 已更新");
    } catch (e) {
      setSchemaError(e instanceof Error ? e.message : String(e));
    } finally {
      setSchemaLoading(false);
    }
  }, [
    currentWorkspaceId,
    activeEnvironmentId,
    environments,
    collections,
    tab,
    message,
  ]);

  // Auto Fetch 模式：URL 变化后防抖自动拉 schema
  const schemaMode = tab.config.body.graphqlSchemaMode ?? "auto";
  const url = tab.config.url;
  useEffect(() => {
    if (schemaMode !== "auto" || !url.trim()) return;
    const timer = setTimeout(() => void fetchSchema(), 1000);
    return () => clearTimeout(timer);
  }, [schemaMode, url, fetchSchema]);

  // ---- Subscription（graphql-transport-ws 子协议，经 Runner 执行（api 实时桥））----
  const [subActive, setSubActive] = useState(false);
  const [bottomTab, setBottomTab] = useState<"response" | "subscription">("response");
  const sub = useRtConnection({
    tab,
    protocol: "graphql-subscription",
    resolveUrl: (raw, vars) => {
      let u = substituteVariables(raw, vars).trim();
      // GraphQL endpoint 一般写 http(s)，WS 子协议端点自动转换
      if (/^https:\/\//i.test(u)) u = u.replace(/^https:/i, "wss:");
      else if (/^http:\/\//i.test(u)) u = u.replace(/^http:/i, "ws:");
      return /^wss?:\/\//i.test(u) ? u : null;
    },
    buildConfig: (vars) => ({
      // graphql-ws 的 connectionParams：把启用的 Headers 作为连接参数（常用于鉴权）
      connectionParams: Object.fromEntries(
        tab.config.headers
          .filter((h) => h.enabled && h.key)
          .map((h) => [h.key, substituteVariables(h.value, vars)]),
      ),
    }),
    formatMessage: (dir, data) => {
      try {
        const frame = JSON.parse(data) as { event?: string; payload?: unknown; error?: string };
        if (dir === "out") return `→ subscribe`;
        if (frame.event === "data") return `← ${JSON.stringify(frame.payload)}`;
        if (frame.event === "error") return `← 订阅错误：${frame.error}`;
        if (frame.event === "complete") return `← 订阅已完成`;
        return data;
      } catch {
        return data;
      }
    },
    onRawEvent: (ev) => {
      if (ev.type !== "message" || ev.dir !== "in" || !ev.data) return;
      try {
        const frame = JSON.parse(ev.data) as { event?: string };
        if (frame.event === "complete" || frame.event === "error") setSubActive(false);
      } catch {
        /* 非 JSON 忽略 */
      }
    },
  });

  /** 发起订阅：未连接先连，连上后发 subscribe 帧并切到订阅面板 */
  const handleSubscribe = async () => {
    const query = (tab.config.body.graphqlQuery ?? "").trim();
    if (!query) {
      message.warning("请先编写 subscription 查询");
      return;
    }
    let variables: Record<string, unknown> | undefined;
    const rawVars = (tab.config.body.graphqlVariables ?? "").trim();
    if (rawVars) {
      try {
        variables = JSON.parse(rawVars) as Record<string, unknown>;
      } catch {
        message.error("Variables 需为合法 JSON");
        return;
      }
    }
    setBottomTab("subscription");
    const open = sub.connected ? true : (void sub.connect(), await sub.whenOpen());
    if (!open) return;
    sub.sendRaw(JSON.stringify({ action: "subscribe", query, variables }));
    setSubActive(true);
  };

  const handleStopSubscription = () => {
    sub.sendRaw(JSON.stringify({ action: "stop" }));
    setSubActive(false);
  };

  const queryExtensions = useMemo(
    () => [EditorView.lineWrapping, cmGraphql(schema ?? undefined)],
    [schema],
  );
  const variablesExtensions = useMemo(
    () => [EditorView.lineWrapping, json()],
    [],
  );
  const schemaTree = useMemo(() => (schema ? buildSchemaTree(schema) : []), [schema]);

  const editorHeightStyle = { flex: 1, minHeight: 0, overflow: "hidden" } as const;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
      }}
    >
      {/* POST + Endpoint URL + Send：GraphQL-over-HTTP 固定 POST */}
      <div style={{ display: "flex", gap: 8, width: "100%", marginBottom: 8 }}>
        <Tag
          color="#e10098"
          style={{
            margin: 0,
            display: "inline-flex",
            alignItems: "center",
            padding: "0 10px",
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          POST
        </Tag>
        <VarInput
          className="code-font"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="https://api.example.com/graphql"
          value={tab.config.url}
          onChange={(u) => patch(tab.key, { url: u })}
          onEnter={onSend}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          loading={tab.sending}
          style={{ flexShrink: 0 }}
          onClick={onSend}
        >
          Send
        </Button>
        {/* Subscription：graphql-transport-ws 子协议，经 Runner 执行（api 实时桥） */}
        {subActive ? (
          <Button
            danger
            icon={<StopOutlined />}
            style={{ flexShrink: 0 }}
            onClick={handleStopSubscription}
          >
            Stop
          </Button>
        ) : (
          <Button
            icon={<ApiOutlined />}
            style={{ flexShrink: 0 }}
            onClick={() => void handleSubscribe()}
          >
            Subscribe
          </Button>
        )}
      </div>

      <Splitter layout="vertical" style={{ flex: 1, minHeight: 0 }}>
        <Splitter.Panel defaultSize="55%" min="15%" style={{ paddingBottom: 4 }}>
          <Tabs
            size="small"
            className="pane-tabs"
            items={[
              {
                key: "query",
                label: "Query",
                children: (
                  <div className="gql-cm" style={editorHeightStyle}>
                    <CodeMirror
                      ref={cmRef as never}
                      value={tab.config.body.graphqlQuery ?? ""}
                      height="100%"
                      placeholder={"query {\n  field\n}"}
                      extensions={queryExtensions}
                      onChange={(graphqlQuery) =>
                        patch(tab.key, {
                          body: { ...tab.config.body, graphqlQuery },
                        })
                      }
                      basicSetup={{
                        foldGutter: true,
                        highlightActiveLine: false,
                        highlightActiveLineGutter: false,
                      }}
                    />
                  </div>
                ),
              },
              {
                key: "variables",
                label: "Variables",
                children: (
                  <div className="gql-cm" style={editorHeightStyle}>
                    <CodeMirror
                      value={tab.config.body.graphqlVariables ?? ""}
                      height="100%"
                      placeholder='{"id": 1}'
                      extensions={variablesExtensions}
                      onChange={(graphqlVariables) =>
                        patch(tab.key, {
                          body: { ...tab.config.body, graphqlVariables },
                        })
                      }
                      basicSetup={{
                        foldGutter: true,
                        highlightActiveLine: false,
                        highlightActiveLineGutter: false,
                      }}
                    />
                  </div>
                ),
              },
              {
                key: "headers",
                label: "Headers",
                children: (
                  <HeadersSection
                    tab={tab}
                    onChange={(headers) => patch(tab.key, { headers })}
                  />
                ),
              },
              {
                key: "auth",
                label: isAuthConfigured(tab.config.auth)
                  ? "Authorization ●"
                  : "Authorization",
                children: (
                  <AuthEditor
                    value={tab.config.auth}
                    onChange={(auth) => patch(tab.key, { auth })}
                  />
                ),
              },
              {
                key: "schema",
                label: "Schema",
                children: (
                  <div style={{ height: "100%", overflow: "auto" }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginBottom: 8,
                      }}
                    >
                      <Button
                        size="small"
                        icon={<ReloadOutlined />}
                        loading={schemaLoading}
                        disabled={schemaMode === "none"}
                        onClick={() => void fetchSchema()}
                      >
                        获取 Schema
                      </Button>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {schemaMode === "none"
                          ? "No Schema 模式：可在 HTTP Body 设置中切换为 Auto Fetch"
                          : schema
                            ? "introspection 拉取成功，Query 编辑器已获得补全与校验"
                            : (schemaError ?? "拉取 introspection schema 后此处展示 API 文档")}
                      </Typography.Text>
                    </div>
                    {schemaTree.length > 0 && (
                      <Tree
                        showLine
                        defaultExpandAll={false}
                        treeData={schemaTree}
                        selectable={false}
                      />
                    )}
                  </div>
                ),
              },
            ]}
          />
        </Splitter.Panel>
        <Splitter.Panel min="15%" style={{ paddingTop: 4 }}>
          <Tabs
            size="small"
            className="pane-tabs gql-bottom-tabs"
            activeKey={bottomTab}
            onChange={(k) => setBottomTab(k as "response" | "subscription")}
            items={[
              {
                key: "response",
                label: "Response",
                children: (
                  <ResponseViewer response={tab.response} sending={tab.sending} />
                ),
              },
              {
                key: "subscription",
                label: "Subscription",
                children: (
                  <div style={{ height: "100%", overflow: "auto" }}>
                    <MessageLog entries={sub.entries} />
                  </div>
                ),
              },
            ]}
          />
        </Splitter.Panel>
      </Splitter>
    </div>
  );
}
