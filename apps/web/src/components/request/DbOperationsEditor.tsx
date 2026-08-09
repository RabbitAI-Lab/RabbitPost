import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { Button, Empty, Input, Select, Tabs, Tag, Typography } from "antd";
import type { DbConnectionDto } from "../../api";
import type { DbExtraction, DbOperation, RequestDbOperations } from "@rabbitpost/shared";
import { useAppStore } from "../../stores/app";
import { useTabsStore, type RequestTab } from "../../stores/tabs";
import VarInput from "../common/variable/VarInput";
import VarTextArea from "../common/variable/VarTextArea";

let seq = 0;
function newOp(): DbOperation {
  return { id: `op-${Date.now()}-${seq++}`, connection: "", kind: "sql", statement: "" };
}

const kindOf = (conn: DbConnectionDto | undefined): DbOperation["kind"] =>
  conn?.type === "redis" ? "redis" : "sql";

/** 连接下拉：按 SQL / Redis 分组，值为连接名（执行期按名称引用，Apifox 风格） */
function connectionOptions(connections: DbConnectionDto[]) {
  const sql = connections.filter((c) => c.type !== "redis");
  const redis = connections.filter((c) => c.type === "redis");
  const toOption = (c: DbConnectionDto) => ({ value: c.name, label: `${c.name} (${c.type})` });
  return [
    ...(sql.length ? [{ label: "SQL", options: sql.map(toOption) }] : []),
    ...(redis.length ? [{ label: "Redis", options: redis.map(toOption) }] : []),
  ];
}

/** 提取来源下拉值与 source 字符串互转：row.<col> 拆成「模式 + 列名」 */
function sourceMode(source: DbExtraction["source"]): string {
  return source.startsWith("row.") && source !== "row" ? "rowCol" : source;
}
function sourceColumn(source: DbExtraction["source"]): string {
  return sourceMode(source) === "rowCol" ? source.slice(4) : "";
}

/** 单条提取规则：变量名 + 来源（rows / row / row.<列名> / value） */
function ExtractionRow({
  value,
  kind,
  onChange,
  onRemove,
}: {
  value: DbExtraction;
  kind: DbOperation["kind"];
  onChange: (v: DbExtraction) => void;
  onRemove: () => void;
}) {
  const mode = sourceMode(value.source);
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <Input
        size="small"
        placeholder="变量名，如 userName"
        style={{ flex: 1, minWidth: 0 }}
        value={value.variable}
        onChange={(e) => onChange({ ...value, variable: e.target.value })}
      />
      <Select
        size="small"
        style={{ width: 130 }}
        value={mode}
        options={
          kind === "redis"
            ? [{ value: "value", label: "value（命令返回值）" }]
            : [
                { value: "rows", label: "rows（全部行）" },
                { value: "row", label: "row（首行）" },
                { value: "rowCol", label: "row.<列名>" },
              ]
        }
        onChange={(v) =>
          onChange({
            ...value,
            source: v === "rowCol" ? "row." : (v as DbExtraction["source"]),
          })
        }
      />
      {mode === "rowCol" && (
        <Input
          size="small"
          placeholder="列名"
          style={{ width: 120 }}
          value={sourceColumn(value.source)}
          onChange={(e) =>
            onChange({ ...value, source: `row.${e.target.value}` as DbExtraction["source"] })
          }
        />
      )}
      <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={onRemove} />
    </div>
  );
}

/** 单个数据库操作卡片：连接选择 + 语句 + 绑定参数 + 变量提取 */
function OperationCard({
  op,
  connections,
  index,
  total,
  onChange,
  onMove,
  onRemove,
}: {
  op: DbOperation;
  connections: DbConnectionDto[];
  index: number;
  total: number;
  onChange: (op: DbOperation) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const conn = connections.find((c) => c.name === op.connection);
  const missing = !!op.connection && !conn;
  return (
    <div
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
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Select
          size="small"
          showSearch
          placeholder="选择连接"
          style={{ flex: 1, minWidth: 0 }}
          value={op.connection || undefined}
          options={connectionOptions(connections)}
          onChange={(name) => {
            const target = connections.find((c) => c.name === name);
            onChange({ ...op, connection: name, kind: kindOf(target) });
          }}
        />
        <Tag color={op.kind === "redis" ? "red" : "blue"} style={{ marginInlineEnd: 0 }}>
          {op.kind === "redis" ? "Redis" : "SQL"}
        </Tag>
        <Button
          type="text"
          size="small"
          icon={<ArrowUpOutlined />}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        />
        <Button
          type="text"
          size="small"
          icon={<ArrowDownOutlined />}
          disabled={index === total - 1}
          onClick={() => onMove(1)}
        />
        <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={onRemove} />
      </div>
      {missing && (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          连接「{op.connection}」不存在或已改名，执行将失败。
        </Typography.Text>
      )}

      <VarTextArea
        className="code-font"
        autoSize={{ minRows: 3, maxRows: 12 }}
        placeholder={
          op.kind === "redis"
            ? "Redis 命令，空格分隔，如 GET token:{{uid}}"
            : "SQL 语句，? 为绑定参数占位，如 SELECT * FROM users WHERE id = ?"
        }
        value={op.statement}
        onChange={(statement) => onChange({ ...op, statement })}
      />

      {op.kind === "sql" && (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
            绑定参数（按 ? 顺序，支持 {"{{var}}"}）
          </Typography.Text>
          {(op.params ?? []).map((p, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 4 }}>
              <VarInput
                size="small"
                style={{ flex: 1, minWidth: 0 }}
                placeholder={`参数 ${i + 1}，如 {{userId}}`}
                value={p}
                onChange={(v) => {
                  const params = [...(op.params ?? [])];
                  params[i] = v;
                  onChange({ ...op, params });
                }}
              />
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() =>
                  onChange({ ...op, params: (op.params ?? []).filter((_, j) => j !== i) })
                }
              />
            </div>
          ))}
          <Button
            type="link"
            size="small"
            icon={<PlusOutlined />}
            style={{ padding: 0 }}
            onClick={() => onChange({ ...op, params: [...(op.params ?? []), ""] })}
          >
            添加参数
          </Button>
        </div>
      )}

      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
          提取变量（结果写入变量表，后续 {"{{var}}"} / 脚本可用）
        </Typography.Text>
        {(op.extract ?? []).map((ex, i) => (
          <div key={i} style={{ marginBottom: 4 }}>
            <ExtractionRow
              value={ex}
              kind={op.kind}
              onChange={(v) => {
                const extract = [...(op.extract ?? [])];
                extract[i] = v;
                onChange({ ...op, extract });
              }}
              onRemove={() =>
                onChange({ ...op, extract: (op.extract ?? []).filter((_, j) => j !== i) })
              }
            />
          </div>
        ))}
        <Button
          type="link"
          size="small"
          icon={<PlusOutlined />}
          style={{ padding: 0 }}
          onClick={() =>
            onChange({
              ...op,
              extract: [
                ...(op.extract ?? []),
                { variable: "", source: op.kind === "redis" ? "value" : "rows" },
              ],
            })
          }
        >
          添加提取
        </Button>
      </div>
    </div>
  );
}

/** 前置 / 后置操作列表（有序） */
function OperationList({
  ops,
  connections,
  onChange,
}: {
  ops: DbOperation[];
  connections: DbConnectionDto[];
  onChange: (ops: DbOperation[]) => void;
}) {
  if (connections.length === 0) {
    return <Empty description="暂无数据库连接，请先在左侧 Databases 创建" style={{ marginTop: 24 }} />;
  }
  const patchAt = (i: number, op: DbOperation) => onChange(ops.map((o, j) => (j === i ? op : o)));
  return (
    <div>
      {ops.map((op, i) => (
        <OperationCard
          key={op.id}
          op={op}
          connections={connections}
          index={i}
          total={ops.length}
          onChange={(o) => patchAt(i, o)}
          onMove={(dir) => {
            const next = [...ops];
            const [moved] = next.splice(i, 1);
            if (moved) next.splice(i + dir, 0, moved);
            onChange(next);
          }}
          onRemove={() => onChange(ops.filter((_, j) => j !== i))}
        />
      ))}
      <Button
        size="small"
        type="primary"
        ghost
        icon={<PlusOutlined />}
        block
        onClick={() => onChange([...ops, newOp()])}
      >
        添加操作
      </Button>
    </div>
  );
}

interface Props {
  tab: RequestTab;
}

/** 请求配置「数据库」tab：编辑 request.dbOperations 的前置 / 后置数据库操作 */
export default function DbOperationsEditor({ tab }: Props) {
  const updateConfig = useTabsStore((s) => s.updateConfig);
  const connections = useAppStore((s) => s.dbConnections);
  const dbOperations: RequestDbOperations = tab.config.dbOperations ?? {};

  const setOps = (phase: "pre" | "post", ops: DbOperation[]) =>
    updateConfig(tab.key, { dbOperations: { ...dbOperations, [phase]: ops } });

  return (
    <Tabs
      size="small"
      tabPosition="left"
      className="scripts-tabs"
      items={[
        {
          key: "pre",
          label: "前置操作",
          children: (
            <div>
              <Typography.Text
                type="secondary"
                style={{ fontSize: 12, display: "block", marginBottom: 8 }}
              >
                在 Pre-request 脚本之前按顺序执行；提取的变量随即可用。
              </Typography.Text>
              <OperationList
                ops={dbOperations.pre ?? []}
                connections={connections}
                onChange={(ops) => setOps("pre", ops)}
              />
            </div>
          ),
        },
        {
          key: "post",
          label: "后置操作",
          children: (
            <div>
              <Typography.Text
                type="secondary"
                style={{ fontSize: 12, display: "block", marginBottom: 8 }}
              >
                响应返回后、Tests 脚本之前按顺序执行，可用于数据清理与断言准备。
              </Typography.Text>
              <OperationList
                ops={dbOperations.post ?? []}
                connections={connections}
                onChange={(ops) => setOps("post", ops)}
              />
            </div>
          ),
        },
      ]}
    />
  );
}
