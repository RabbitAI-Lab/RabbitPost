import { Collapse, Empty, Tag, Typography } from "antd";
import { useMemo } from "react";
import type { SpecOperationDoc, SpecOutline, SpecType } from "@rabbitpost/shared";
import { buildSpecOutline, isAsyncApi } from "@rabbitpost/shared";

const METHOD_COLORS: Record<string, string> = {
  GET: "#61affe",
  POST: "#49cc90",
  PUT: "#fca130",
  PATCH: "#50e3c2",
  DELETE: "#f93e3e",
  HEAD: "#9012fe",
  OPTIONS: "#0d5aa7",
};

interface Props {
  content: string;
  type: SpecType;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.8,
        color: "#595959",
        margin: "14px 0 6px",
      }}
    >
      {children}
    </div>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <pre
      className="code-font"
      style={{
        margin: "4px 0 0",
        padding: 8,
        background: "#fafafa",
        border: "1px solid #f0f0f0",
        borderRadius: 4,
        maxHeight: 220,
        overflow: "auto",
        whiteSpace: "pre-wrap",
      }}
    >
      {text}
    </pre>
  );
}

function OperationBody({ operation }: { operation: SpecOperationDoc }) {
  return (
    <div style={{ fontSize: 12 }}>
      {operation.description && (
        <Typography.Paragraph style={{ fontSize: 12, marginBottom: 8 }}>
          {operation.description}
        </Typography.Paragraph>
      )}

      {operation.params.length > 0 && (
        <>
          <SectionTitle>PARAMETERS</SectionTitle>
          {operation.params.map((param) => (
            <div key={`${param.in}-${param.name}`} style={{ marginBottom: 4 }}>
              <span className="code-font" style={{ fontWeight: 600 }}>
                {param.name}
              </span>
              <Tag style={{ marginLeft: 6, fontSize: 10 }}>{param.in}</Tag>
              {param.required && (
                <Tag color="red" style={{ fontSize: 10 }}>
                  required
                </Tag>
              )}
              {param.schema && (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {param.schema}
                </Typography.Text>
              )}
              {param.description && (
                <div style={{ color: "#8c8c8c", fontSize: 11 }}>{param.description}</div>
              )}
            </div>
          ))}
        </>
      )}

      {operation.requestExample && (
        <>
          <SectionTitle>REQUEST BODY · {operation.requestContentType}</SectionTitle>
          <CodeBlock text={operation.requestExample} />
        </>
      )}

      {operation.responses.length > 0 && (
        <>
          <SectionTitle>RESPONSES</SectionTitle>
          {operation.responses.map((response) => (
            <div key={response.code} style={{ marginBottom: 8 }}>
              <Tag
                color={response.code.startsWith("2") ? "green" : "default"}
                style={{ fontSize: 11 }}
              >
                {response.code}
              </Tag>
              <span style={{ color: "#595959" }}>{response.description}</span>
              {response.contentType && (
                <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
                  {response.contentType}
                </Typography.Text>
              )}
              {response.example && <CodeBlock text={response.example} />}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/** 按 tag 分组的端点列表；无 tag 的端点归入「未分组」 */
function groupByTag(outline: SpecOutline): { tag: string; operations: SpecOperationDoc[] }[] {
  const groups = new Map<string, SpecOperationDoc[]>();
  for (const operation of outline.operations) {
    const tag = operation.tags[0] ?? "未分组";
    const list = groups.get(tag) ?? [];
    list.push(operation);
    groups.set(tag, list);
  }
  return [...groups.entries()].map(([tag, operations]) => ({ tag, operations }));
}

/** spec 编辑器右侧文档预览：由定义实时渲染出 API 文档（对齐 Postman 的文档面板） */
export default function SpecDocsPreview({ content, type }: Props) {
  const outline = useMemo(() => buildSpecOutline(content, type), [content, type]);

  if (!outline) {
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
        <Empty description="定义存在语法错误，无法生成预览" />
      </div>
    );
  }

  return (
    <div
      className="slim-scroll"
      style={{ height: "100%", overflow: "auto", padding: "10px 12px" }}
    >
      <Typography.Title level={5} style={{ marginBottom: 2 }}>
        {outline.title || "（未命名）"}
      </Typography.Title>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {outline.version && `v${outline.version}`}
      </Typography.Text>
      {outline.description && (
        <Typography.Paragraph style={{ fontSize: 12, marginTop: 8 }}>
          {outline.description}
        </Typography.Paragraph>
      )}

      {outline.servers.length > 0 && (
        <>
          <SectionTitle>SERVERS</SectionTitle>
          {outline.servers.map((server) => (
            <div key={server.url} style={{ fontSize: 12 }}>
              <span className="code-font">{server.url}</span>
              {server.description && (
                <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
                  {server.description}
                </Typography.Text>
              )}
            </div>
          ))}
        </>
      )}

      {outline.security.length > 0 && (
        <>
          <SectionTitle>AUTHORIZATION</SectionTitle>
          {outline.security.map((scheme) => (
            <div key={scheme.name} style={{ fontSize: 12 }}>
              <span style={{ fontWeight: 600 }}>{scheme.name}</span>
              <Tag style={{ marginLeft: 6, fontSize: 10 }}>{scheme.type}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {scheme.detail}
              </Typography.Text>
            </div>
          ))}
        </>
      )}

      {isAsyncApi(type) ? (
        <>
          <SectionTitle>CHANNELS</SectionTitle>
          {outline.channels.length === 0 ? (
            <Empty description="定义中没有 channel" />
          ) : (
            <Collapse
              size="small"
              items={outline.channels.map((channel) => ({
                key: channel.name,
                label: (
                  <span className="code-font" style={{ fontSize: 12 }}>
                    {channel.name}
                  </span>
                ),
                children: (
                  <div style={{ fontSize: 12 }}>
                    {channel.description && (
                      <Typography.Paragraph style={{ fontSize: 12 }}>
                        {channel.description}
                      </Typography.Paragraph>
                    )}
                    {channel.operations.map((operation) => (
                      <div key={operation.kind} style={{ marginBottom: 8 }}>
                        <Tag color="blue" style={{ fontSize: 10 }}>
                          {operation.kind}
                        </Tag>
                        <span>{operation.summary}</span>
                        {operation.payloadExample && (
                          <CodeBlock text={operation.payloadExample} />
                        )}
                      </div>
                    ))}
                  </div>
                ),
              }))}
            />
          )}
        </>
      ) : (
        <>
          <SectionTitle>ENDPOINTS</SectionTitle>
          {outline.operations.length === 0 ? (
            <Empty description="定义中没有端点" />
          ) : (
            groupByTag(outline).map((group) => (
              <div key={group.tag} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, margin: "6px 0 4px" }}>
                  {group.tag}
                </div>
                <Collapse
                  size="small"
                  items={group.operations.map((operation) => ({
                    key: operation.key,
                    label: (
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span
                          className="code-font"
                          style={{
                            color: METHOD_COLORS[operation.method] ?? "#666",
                            fontWeight: 700,
                            fontSize: 10,
                          }}
                        >
                          {operation.method}
                        </span>
                        <span className="code-font" style={{ fontSize: 12 }}>
                          {operation.path}
                        </span>
                        {operation.deprecated && (
                          <Tag color="orange" style={{ fontSize: 10 }}>
                            deprecated
                          </Tag>
                        )}
                        {operation.summary && (
                          <Typography.Text
                            type="secondary"
                            ellipsis
                            style={{ fontSize: 11, flex: 1, minWidth: 0 }}
                          >
                            {operation.summary}
                          </Typography.Text>
                        )}
                      </span>
                    ),
                    children: <OperationBody operation={operation} />,
                  }))}
                />
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
