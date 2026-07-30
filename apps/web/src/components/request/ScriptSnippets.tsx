import { SearchOutlined } from "@ant-design/icons";
import { Input, Typography } from "antd";
import { useState } from "react";

/** 脚本阶段：Pre-request / Tests */
export type ScriptPhase = "pre-request" | "test";

interface Snippet {
  label: string;
  code: string;
}

interface SnippetGroup {
  /** 分组标题（如 Variables）；无标题的组直接平铺 */
  title?: string;
  /** 仅在指定阶段显示；缺省两个阶段都显示 */
  phase?: ScriptPhase;
  snippets: Snippet[];
}

/** 代码片段清单（仅收录沙箱已支持的 rp API，参考 Postman Snippets） */
const SNIPPET_GROUPS: SnippetGroup[] = [
  {
    title: "Variables",
    snippets: [
      {
        label: "Get an environment variable",
        code: 'rp.environment.get("variable_key");',
      },
      {
        label: "Get a variable",
        code: 'rp.variables.get("variable_key");',
      },
      {
        label: "Set an environment variable",
        code: 'rp.environment.set("variable_key", "variable_value");',
      },
      {
        label: "Set a variable",
        code: 'rp.variables.set("variable_key", "variable_value");',
      },
      {
        label: "Clear an environment variable",
        code: 'rp.environment.unset("variable_key");',
      },
    ],
  },
  {
    title: "Console",
    snippets: [
      {
        label: "Log a value to the console",
        code: 'console.log("value");',
      },
    ],
  },
  {
    title: "Tests",
    phase: "test",
    snippets: [
      {
        label: "Status code: Code is 200",
        code:
          'rp.test("Status code is 200", () => {\n' +
          "  rp.response.to.have.status(200);\n" +
          "});",
      },
      {
        label: "Response body: Contains string",
        code:
          'rp.test("Body contains string", () => {\n' +
          '  rp.expect(rp.response.text()).to.include("string_to_check");\n' +
          "});",
      },
      {
        label: "Response body: JSON value check",
        code:
          'rp.test("JSON value check", () => {\n' +
          "  const jsonData = rp.response.json();\n" +
          '  rp.expect(jsonData.value).to.eql("expected_value");\n' +
          "});",
      },
      {
        label: "Response time is less than 200ms",
        code:
          'rp.test("Response time is less than 200ms", () => {\n' +
          "  rp.expect(rp.response.time).to.be.below(200);\n" +
          "});",
      },
      {
        label: "Status code: Successful POST request",
        code:
          'rp.test("Successful POST request", () => {\n' +
          "  rp.expect(rp.response.code).to.be.oneOf([201, 202]);\n" +
          "});",
      },
      {
        label: "Response headers: Content-Type check",
        code:
          'rp.test("Content-Type header is present", () => {\n' +
          '  rp.expect(rp.response.headers["content-type"]).to.exist();\n' +
          "});",
      },
    ],
  },
];

interface Props {
  phase: ScriptPhase;
  /** 点击片段时把代码插入脚本编辑区 */
  onInsert: (code: string) => void;
}

/** 脚本编辑区右侧的 Snippets 面板：搜索 + 分组片段列表（同 Postman） */
export default function ScriptSnippets({ phase, onInsert }: Props) {
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLowerCase();

  const groups = SNIPPET_GROUPS.filter(
    (g) => !g.phase || g.phase === phase,
  )
    .map((g) => ({
      ...g,
      snippets: keyword
        ? g.snippets.filter((s) => s.label.toLowerCase().includes(keyword))
        : g.snippets,
    }))
    .filter((g) => g.snippets.length > 0);

  return (
    <div
      style={{
        width: 240,
        flex: "none",
        border: "1px solid #e8e8e8",
        borderRadius: 6,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        alignSelf: "stretch",
        minHeight: 0,
      }}
    >
      <Input
        size="small"
        variant="borderless"
        prefix={<SearchOutlined style={{ color: "#bfbfbf" }} />}
        placeholder="Search snippets"
        allowClear
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ padding: "6px 8px", borderBottom: "1px solid #e8e8e8", borderRadius: 0 }}
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 0" }}>
        {groups.length === 0 && (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, display: "block", padding: "8px 12px" }}
          >
            未找到匹配的片段
          </Typography.Text>
        )}
        {groups.map((g) => (
          <div key={g.title ?? "ungrouped"}>
            {g.title && (
              <div
                style={{
                  padding: "8px 12px 4px",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "#8c8c8c",
                }}
              >
                {g.title}
              </div>
            )}
            {g.snippets.map((s) => (
              <div
                key={s.label}
                className="sidebar-hover"
                style={{
                  padding: "5px 12px",
                  fontSize: 12,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={s.label}
                onClick={() => onInsert(s.code)}
              >
                {s.label}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
