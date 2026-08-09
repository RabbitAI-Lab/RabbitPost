import {
  CaretRightOutlined,
  FolderOutlined,
  HolderOutlined,
} from "@ant-design/icons";
import {
  App,
  Button,
  Checkbox,
  Empty,
  InputNumber,
  Radio,
  Spin,
  Tooltip,
  Typography,
} from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RUN_REPORT_FORMAT,
  RUN_REPORT_VERSION,
  type CollectionItem,
  type ExecuteResult,
  type RunReportSummary,
} from "@rabbitpost/shared";
import { runsApi } from "../../api";
import { ApiError } from "../../api/client";
import { useAppStore } from "../../stores/app";
import type { RunnerTab } from "../../stores/tabs";
import { executeRequestConfig } from "../../lib/execute";

const METHOD_COLORS: Record<string, string> = {
  GET: "#61affe",
  POST: "#49cc90",
  PUT: "#fca130",
  PATCH: "#50e3c2",
  DELETE: "#f93e3e",
  HEAD: "#9012fe",
  OPTIONS: "#0d5aa7",
};

function MethodTag({ method }: { method?: string }) {
  if (!method) return null;
  return (
    <span
      className="code-font"
      style={{
        color: METHOD_COLORS[method] ?? "#666",
        fontWeight: 700,
        fontSize: 10,
        marginRight: 5,
        flexShrink: 0,
        minWidth: 40,
        display: "inline-block",
      }}
    >
      {method}
    </span>
  );
}

/** 扁平化 Collection 树为请求列表（先序遍历，含文件夹路径） */
interface FlatRequest {
  item: CollectionItem;
  /** 文件夹路径前缀，如 "Folder A / Sub Folder" */
  folderPath: string;
  /** 嵌套深度（用于缩进展示） */
  depth: number;
}

function flattenTree(items: CollectionItem[], folderPath = "", depth = 0): FlatRequest[] {
  const result: FlatRequest[] = [];
  for (const item of items) {
    if (item.type === "folder") {
      const path = folderPath ? `${folderPath} / ${item.name}` : item.name;
      result.push(...flattenTree(item.children ?? [], path, depth + 1));
    } else if (item.type === "request" && item.request) {
      result.push({ item, folderPath, depth });
    }
  }
  return result;
}

/** 执行状态 */
interface RunItemState {
  checked: boolean;
  status: "pending" | "running" | "success" | "failed";
  result?: ExecuteResult;
}

interface Props {
  tab: RunnerTab;
}

export default function CollectionRunner({ tab }: Props) {
  const { message } = App.useApp();
  const {
    currentWorkspaceId,
    activeEnvironmentId,
    environments,
    collectionTrees,
    collections,
    workspaces,
  } = useAppStore();

  const collectionName =
    collections.find((c) => c.id === tab.collectionId)?.name ?? "";

  // 从 collection tree 扁平化请求列表
  const flatRequests = useMemo(() => {
    const tree = collectionTrees[tab.collectionId] ?? [];
    return flattenTree(tree);
  }, [collectionTrees, tab.collectionId]);

  // 编排后的顺序（item id 数组，初始与 flatRequests 相同）
  const [orderedIds, setOrderedIds] = useState<string[]>([]);
  // 每个请求的运行状态
  const [itemStates, setItemStates] = useState<Map<string, RunItemState>>(new Map());
  // 是否正在运行
  const [running, setRunning] = useState(false);
  // 是否已运行过至少一次
  const [hasRun, setHasRun] = useState(false);

  // Run type
  const [runType, setRunType] = useState<"functional" | "performance">("functional");
  // Iterations
  const [iterations, setIterations] = useState(1);
  // Settings
  const [persistResponses, setPersistResponses] = useState(true);
  const [stopOnError, setStopOnError] = useState(true);
  const [keepVariableValues, setKeepVariableValues] = useState(true);
  const [delayMs, setDelayMs] = useState(0);
  const [useDelay, setUseDelay] = useState(false);

  // 初始化 orderedIds 和 itemStates
  useEffect(() => {
    const ids = flatRequests.map((r) => r.item.id);
    setOrderedIds(ids);
    setItemStates((prev) => {
      const next = new Map<string, RunItemState>();
      for (const id of ids) {
        next.set(id, prev.get(id) ?? { checked: true, status: "pending" });
      }
      return next;
    });
  }, [flatRequests]);

  // 按编排顺序排列的请求列表
  const orderedRequests = useMemo(() => {
    const byId = new Map(flatRequests.map((r) => [r.item.id, r]));
    return orderedIds
      .map((id) => byId.get(id))
      .filter((r): r is FlatRequest => r !== undefined);
  }, [flatRequests, orderedIds]);

  // 选中的请求数
  const checkedCount = useMemo(
    () => orderedRequests.filter((r) => itemStates.get(r.item.id)?.checked).length,
    [orderedRequests, itemStates],
  );

  // 全选 / 全不选
  const handleSelectAll = useCallback(() => {
    setItemStates((prev) => {
      const next = new Map(prev);
      for (const [id, state] of next) {
        next.set(id, { ...state, checked: true });
      }
      return next;
    });
  }, []);

  const handleDeselectAll = useCallback(() => {
    setItemStates((prev) => {
      const next = new Map(prev);
      for (const [id, state] of next) {
        next.set(id, { ...state, checked: false });
      }
      return next;
    });
  }, []);

  const handleReset = useCallback(() => {
    const ids = flatRequests.map((r) => r.item.id);
    setOrderedIds(ids);
    setItemStates(() => {
      const next = new Map<string, RunItemState>();
      for (const id of ids) {
        next.set(id, { checked: true, status: "pending" });
      }
      return next;
    });
    setHasRun(false);
  }, [flatRequests]);

  // 切换单个请求的选中状态
  const toggleChecked = useCallback((itemId: string) => {
    setItemStates((prev) => {
      const next = new Map(prev);
      const state = next.get(itemId);
      if (state) {
        next.set(itemId, { ...state, checked: !state.checked });
      }
      return next;
    });
  }, []);

  // 拖拽排序
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);

  const handleDragStart = (index: number) => {
    dragItem.current = index;
  };

  const handleDragEnter = (index: number) => {
    dragOverItem.current = index;
  };

  const handleDragEnd = () => {
    if (dragItem.current === null || dragOverItem.current === null) return;
    const from = dragItem.current;
    const to = dragOverItem.current;
    if (from === to) return;

    setOrderedIds((prev) => {
      const next = [...prev];
      const [removed] = next.splice(from, 1);
      if (removed !== undefined) {
        next.splice(to, 0, removed);
      }
      return next;
    });

    dragItem.current = null;
    dragOverItem.current = null;
  };

  // 运行结果统计
  const runStats = useMemo(() => {
    if (!hasRun) return null;
    let succeeded = 0;
    let failed = 0;
    for (const [, state] of itemStates) {
      if (state.status === "success") succeeded++;
      else if (state.status === "failed") failed++;
    }
    return { succeeded, failed, total: succeeded + failed };
  }, [hasRun, itemStates]);

  // 开始运行
  const handleStartRun = async () => {
    if (!currentWorkspaceId) return;
    const toRun = orderedRequests.filter((r) => itemStates.get(r.item.id)?.checked);
    if (toRun.length === 0) {
      message.warning("请至少勾选一个请求");
      return;
    }

    setRunning(true);
    setHasRun(true);
    const startedAt = new Date();

    // 收集逐请求执行结果，运行结束后统一持久化到后端
    const collected: { req: FlatRequest; result: ExecuteResult }[] = [];
    let shouldStop = false;

    // 重置所有状态
    setItemStates((prev) => {
      const next = new Map(prev);
      for (const [id, state] of next) {
        next.set(id, { ...state, status: "pending", result: undefined });
      }
      return next;
    });

    for (let iter = 0; iter < iterations && !shouldStop; iter++) {
      for (const req of toRun) {
        if (shouldStop) break;

        // 标记为 running
        setItemStates((prev) => {
          const next = new Map(prev);
          next.set(req.item.id, { ...next.get(req.item.id)!, status: "running" });
          return next;
        });

        try {
          const result = await executeRequestConfig({
            workspaceId: currentWorkspaceId,
            environmentId: activeEnvironmentId,
            environments,
            name: req.item.name,
            config: req.item.request!,
            itemId: req.item.id,
            collectionVariables: collections.find((c) => c.id === tab.collectionId)?.variables,
            globalVariables: workspaces.find((w) => w.id === currentWorkspaceId)?.variables,
          });
          collected.push({ req, result });

          setItemStates((prev) => {
            const next = new Map(prev);
            next.set(req.item.id, {
              ...next.get(req.item.id)!,
              status: result.ok ? "success" : "failed",
              result,
            });
            return next;
          });

          if (!result.ok && stopOnError) {
            shouldStop = true;
            message.warning(`请求「${req.item.name}」失败，已停止运行`);
          }
        } catch (e) {
          const errorMsg = e instanceof Error ? e.message : String(e);
          // 构造一个失败结果，使错误信息能保存到 state / collected（不丢失原因）
          const errorResult: ExecuteResult = {
            ok: false,
            error: errorMsg,
            testResults: [],
            consoleLogs: [],
          };
          collected.push({ req, result: errorResult });

          setItemStates((prev) => {
            const next = new Map(prev);
            next.set(req.item.id, {
              ...next.get(req.item.id)!,
              status: "failed",
              result: errorResult,
            });
            return next;
          });

          if (stopOnError) {
            shouldStop = true;
            message.error(`请求「${req.item.name}」异常：${errorMsg}`);
          }
        }

        // 请求间延迟
        if (!shouldStop && useDelay && delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    setRunning(false);
    if (!shouldStop) {
      message.success("运行完成");
    }

    // 持久化运行结果到后端，使其出现在 Collection 的 Runs 历史中
    if (collected.length > 0) {
      const finishedAt = new Date();
      const succeeded = collected.filter((c) => c.result.ok).length;
      const total = collected.length;
      const tests = collected.flatMap((c) => c.result.testResults ?? []);
      const summary: RunReportSummary = {
        total,
        succeeded,
        failed: total - succeeded,
        testsPassed: tests.filter((t) => t.passed).length,
        testsFailed: tests.filter((t) => !t.passed).length,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      };
      try {
        await runsApi.uploadRun(tab.collectionId, {
          format: RUN_REPORT_FORMAT,
          version: RUN_REPORT_VERSION,
          source: "web",
          agent: "rabbitpost-web",
          collectionId: tab.collectionId,
          targetType: "collection",
          targetId: tab.collectionId,
          targetName: collectionName || tab.collectionId,
          environmentId: activeEnvironmentId ?? null,
          environmentName:
            environments.find((e) => e.id === activeEnvironmentId)?.name ?? null,
          concurrency: 1,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          summary,
          results: collected.map(({ req, result }) => ({
            itemId: req.item.id,
            name: req.item.name,
            method: req.item.request?.method ?? "GET",
            url: req.item.request?.url ?? "",
            ok: result.ok,
            status: result.status ?? null,
            statusText: result.statusText ?? null,
            sizeBytes: result.sizeBytes ?? null,
            durationMs: result.durationMs ?? null,
            error: result.error ?? null,
            testResults: result.testResults ?? null,
            consoleLogs: result.consoleLogs ?? null,
            request: req.item.request!,
            responseHeaders: result.headers ?? null,
            responseBody: result.bodyBase64 ? null : (result.bodyText ?? null),
          })),
        });
        // 通知 Collection Runs 面板刷新历史
        window.dispatchEvent(
          new CustomEvent("rabbitpost:collection-runs-updated", {
            detail: { collectionId: tab.collectionId },
          }),
        );
      } catch (e) {
        // 展示完整的后端错误详情（ApiError 含 code / upstreamBody）
        if (e instanceof ApiError) {
          const detail = e.upstreamBody
            ? typeof e.upstreamBody === "string"
              ? e.upstreamBody
              : JSON.stringify(e.upstreamBody)
            : e.message;
          message.error({
            content: `运行记录保存失败（${e.code}）：${detail}`,
            duration: 10,
          });
        } else {
          message.error(
            `运行记录保存失败：${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
  };

  if (flatRequests.length === 0) {
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
        <Empty description="该 Collection 暂无请求" />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* 左侧：Run order */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid #f0f0f0",
        }}
      >
        {/* Run order 标题栏 */}
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid #f0f0f0",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <Typography.Text strong style={{ fontSize: 13 }}>
            Run order
          </Typography.Text>
          <span style={{ display: "inline-flex", gap: 8 }}>
            <Button type="link" size="small" onClick={handleDeselectAll}>
              Deselect All
            </Button>
            <Button type="link" size="small" onClick={handleSelectAll}>
              Select All
            </Button>
            <Button type="link" size="small" onClick={handleReset}>
              Reset
            </Button>
          </span>
        </div>

        {/* Run Sequence 标签 */}
        <div
          style={{
            padding: "4px 12px",
            borderBottom: "1px solid #f0f0f0",
            flexShrink: 0,
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Run Sequence
          </Typography.Text>
        </div>

        {/* 请求列表 */}
        <div style={{ flex: 1, overflow: "auto", padding: "0 4px" }}>
          {orderedRequests.map((req, index) => {
            const state = itemStates.get(req.item.id);
            return (
              <div
                key={req.item.id}
                draggable={!running}
                onDragStart={() => handleDragStart(index)}
                onDragEnter={() => handleDragEnter(index)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => e.preventDefault()}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "3px 8px",
                  borderRadius: 4,
                  cursor: running ? "default" : "grab",
                  opacity: state?.checked ? 1 : 0.45,
                  background:
                    state?.status === "running"
                      ? "#e6f4ff"
                      : state?.status === "success"
                        ? "#f6ffed"
                        : state?.status === "failed"
                          ? "#fff2f0"
                          : "transparent",
                  transition: "background 0.2s",
                }}
              >
                {/* 序号 */}
                <span
                  style={{
                    width: 24,
                    textAlign: "right",
                    fontSize: 12,
                    color: "#999",
                    flexShrink: 0,
                  }}
                >
                  {index + 1}
                </span>

                {/* 拖拽手柄 */}
                <HolderOutlined
                  style={{ fontSize: 12, color: "#ccc", flexShrink: 0 }}
                />

                {/* 勾选框 */}
                <Checkbox
                  checked={state?.checked ?? true}
                  onChange={() => toggleChecked(req.item.id)}
                  disabled={running}
                />

                {/* 文件夹图标或缩进 */}
                {req.depth > 0 && (
                  <span style={{ width: req.depth * 12, flexShrink: 0 }} />
                )}
                {req.folderPath && (
                  <Tooltip title={req.folderPath}>
                    <FolderOutlined
                      style={{ fontSize: 14, color: "#8c8c8c", flexShrink: 0 }}
                    />
                  </Tooltip>
                )}

                {/* HTTP 方法 */}
                <MethodTag method={req.item.request?.method} />

                {/* 请求名称 */}
                <Typography.Text
                  ellipsis
                  style={{ fontSize: 13, flex: 1, minWidth: 0 }}
                >
                  {req.item.name}
                </Typography.Text>

                {/* 运行状态指示 */}
                {state?.status === "running" && <Spin size="small" />}
                {state?.status === "success" && (
                  <span style={{ color: "#52c41a", fontSize: 12 }}>✓</span>
                )}
                {state?.status === "failed" &&
                  state.result?.error && (
                    <Tooltip
                      title={<span style={{ whiteSpace: "pre-wrap" }}>{state.result.error}</span>}
                      placement="topLeft"
                    >
                      <span style={{ color: "#ff4d4f", fontSize: 12, cursor: "help" }}>✗</span>
                    </Tooltip>
                  )}
                {state?.status === "failed" && !state.result?.error && (
                  <span style={{ color: "#ff4d4f", fontSize: 12 }}>✗</span>
                )}
                {state?.result && state.result.status && (
                  <span
                    style={{
                      fontSize: 11,
                      color: state.result.ok ? "#999" : "#ff4d4f",
                      flexShrink: 0,
                    }}
                  >
                    {state.result.status} · {state.result.durationMs}ms
                  </span>
                )}
                {/* 失败但无 HTTP 状态码（网络/执行异常）：直接显示错误摘要 */}
                {state?.result &&
                  !state.result.ok &&
                  !state.result.status &&
                  state.result.error && (
                    <Typography.Text
                      ellipsis
                      style={{
                        fontSize: 11,
                        color: "#ff4d4f",
                        maxWidth: 200,
                        flexShrink: 1,
                      }}
                    >
                      {state.result.error}
                    </Typography.Text>
                  )}
              </div>
            );
          })}
        </div>

        {/* 底部统计 */}
        {runStats && (
          <div
            style={{
              padding: "8px 12px",
              borderTop: "1px solid #f0f0f0",
              flexShrink: 0,
              fontSize: 12,
            }}
          >
            <Typography.Text type="success">{runStats.succeeded} passed</Typography.Text>
            {" · "}
            <Typography.Text type="danger">{runStats.failed} failed</Typography.Text>
            {" · "}
            <Typography.Text type="secondary">{runStats.total} total</Typography.Text>
          </div>
        )}
      </div>

      {/* 右侧：配置面板 */}
      <div
        style={{
          width: 320,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          padding: "16px 16px 0",
          overflow: "auto",
        }}
      >
        {/* Run type */}
        <div style={{ marginBottom: 20 }}>
          <Typography.Text strong style={{ fontSize: 13, display: "block", marginBottom: 8 }}>
            Run type
          </Typography.Text>
          <Radio.Group
            value={runType}
            onChange={(e) => setRunType(e.target.value)}
            style={{ display: "flex", flexDirection: "column", gap: 8 }}
          >
            <Radio value="functional">
              <div>
                <div style={{ fontSize: 13 }}>Functional</div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  Validate request correctness and test results
                </Typography.Text>
              </div>
            </Radio>
            <Radio value="performance" disabled>
              <div>
                <div style={{ fontSize: 13 }}>Performance</div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  Measure response times and load behavior
                </Typography.Text>
              </div>
            </Radio>
          </Radio.Group>
        </div>

        {/* Iterations */}
        <div style={{ marginBottom: 20 }}>
          <Typography.Text strong style={{ fontSize: 13, display: "block", marginBottom: 8 }}>
            Iterations
          </Typography.Text>
          <InputNumber
            size="small"
            min={1}
            max={100}
            value={iterations}
            onChange={(v) => setIterations(v ?? 1)}
            style={{ width: "100%" }}
            disabled={running}
          />
        </div>

        {/* Settings */}
        <div style={{ marginBottom: 20 }}>
          <Typography.Text strong style={{ fontSize: 13, display: "block", marginBottom: 8 }}>
            Settings
          </Typography.Text>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Checkbox
              checked={persistResponses}
              onChange={(e) => setPersistResponses(e.target.checked)}
              disabled={running}
            >
              <span style={{ fontSize: 12 }}>Persist responses for a session</span>
            </Checkbox>
            <Checkbox
              checked={stopOnError}
              onChange={(e) => setStopOnError(e.target.checked)}
              disabled={running}
            >
              <span style={{ fontSize: 12 }}>Stop run if an error occurs</span>
            </Checkbox>
            <Checkbox
              checked={keepVariableValues}
              onChange={(e) => setKeepVariableValues(e.target.checked)}
              disabled={running}
            >
              <span style={{ fontSize: 12 }}>Keep variable values</span>
            </Checkbox>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Checkbox
                checked={useDelay}
                onChange={(e) => setUseDelay(e.target.checked)}
                disabled={running}
              >
                <span style={{ fontSize: 12 }}>Add a delay of</span>
              </Checkbox>
              <InputNumber
                size="small"
                min={0}
                max={60000}
                value={delayMs}
                onChange={(v) => setDelayMs(v ?? 0)}
                style={{ width: 70 }}
                disabled={!useDelay || running}
              />
              <span style={{ fontSize: 12, color: "#999" }}>ms between requests</span>
            </div>
          </div>
        </div>

        {/* Start run 按钮 */}
        <Button
          type="primary"
          icon={running ? <Spin size="small" /> : <CaretRightOutlined />}
          onClick={() => void handleStartRun()}
          disabled={running || checkedCount === 0}
          block
          style={{ marginBottom: 16 }}
        >
          {running ? "Running..." : `Start run (${checkedCount} requests)`}
        </Button>
      </div>
    </div>
  );
}
