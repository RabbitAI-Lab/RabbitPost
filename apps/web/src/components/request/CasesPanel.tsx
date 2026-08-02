import {
  CaretRightOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  LoadingOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { App, Button, Dropdown, Empty, Input, Modal, Tooltip, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { ExecuteResult, RequestCase } from "@rabbitpost/shared";
import { casesApi } from "../../api";
import {
  loadCaseRuns,
  saveCaseRun,
  type CaseRunRecord,
} from "../../lib/case-runs";
import { executeRequestConfig } from "../../lib/execute";
import { useAppStore } from "../../stores/app";
import { useCasesStore } from "../../stores/cases";
import { useTabsStore, type RequestTab } from "../../stores/tabs";
import CaseRunHistoryPanel from "./CaseRunHistoryPanel";

interface Props {
  /** 接口的 request tab（Cases 面板挂在其配置区） */
  tab: RequestTab;
}

/** 单个用例的运行结果（会话内存态，不落库） */
interface CaseRunState {
  running?: boolean;
  passed?: boolean;
  status?: number;
  statusText?: string;
  durationMs?: number;
  testPassed?: number;
  testTotal?: number;
  error?: string;
}

function statusColor(status?: number): string {
  if (status === undefined) return "rgba(0,0,0,0.25)";
  if (status < 400) return "#52c41a";
  if (status < 500) return "#faad14";
  return "#ff4d4f";
}

/** 接口用例面板：列表 + New Case / Run All / 行内 Run / Open / 重命名 / 复制 / 重置 / 删除 */
export default function CasesPanel({ tab }: Props) {
  const { message, modal } = App.useApp();
  const { currentWorkspaceId, activeEnvironmentId, environments } = useAppStore();
  const itemId = tab.itemId;
  const cases = useCasesStore((s) => (itemId ? s.byItemId[itemId] : undefined));
  const { load, upsert, remove } = useCasesStore();
  const { openCase, closeTab, renameTab, replaceConfig, markSaved, setResponse } =
    useTabsStore();

  const [results, setResults] = useState<Record<string, CaseRunState>>({});
  const [runningAll, setRunningAll] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RequestCase | null>(null);
  const [renameValue, setRenameValue] = useState("");
  /** 运行历史（服务端持久化）；追加后刷新 */
  const [history, setHistory] = useState<CaseRunRecord[]>([]);

  const refreshHistory = async (id: string) => {
    try {
      setHistory(await loadCaseRuns(id));
    } catch {
      // 历史加载失败不阻塞主流程
    }
  };

  useEffect(() => {
    if (itemId) {
      void load(itemId);
      void refreshHistory(itemId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, load]);

  const patchResult = (caseId: string, patch: CaseRunState) =>
    setResults((prev) => ({ ...prev, [caseId]: { ...prev[caseId], ...patch } }));

  /** 执行单个用例并返回结果（不写历史；历史由调用方按 single/batch 语义写入）；
   *  若该用例的编辑 tab 已打开，响应同步过去 */
  const runOne = async (caseRow: RequestCase): Promise<ExecuteResult | null> => {
    if (!currentWorkspaceId) {
      message.warning("请先选择 Workspace");
      return null;
    }
    patchResult(caseRow.id, { running: true, error: undefined });
    try {
      const r = await executeRequestConfig({
        workspaceId: currentWorkspaceId,
        environmentId: activeEnvironmentId,
        environments,
        name: `${tab.name} / ${caseRow.name}`,
        config: caseRow.request,
        itemId: tab.itemId ?? undefined, // 传入 Collection Item ID，用于 Runner 模式
      });
      const testTotal = r.testResults?.length ?? 0;
      const testPassed = (r.testResults ?? []).filter((t) => t.passed).length;
      patchResult(caseRow.id, {
        running: false,
        passed: r.ok && testPassed === testTotal,
        status: r.status,
        statusText: r.statusText,
        durationMs: r.durationMs,
        testPassed,
        testTotal,
        error: r.error,
      });
      // 用例编辑 tab 已打开：把响应同步过去，便于查看 Body/断言明细
      const caseTabKey = `case-${caseRow.id}`;
      if (useTabsStore.getState().tabs.some((t) => t.key === caseTabKey)) {
        setResponse(caseTabKey, r);
      }
      return r;
    } catch (e) {
      patchResult(caseRow.id, {
        running: false,
        passed: false,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  };

  /** 单条 Run：执行后上报一条 single 历史（报告只含该用例） */
  const handleRunSingle = async (caseRow: RequestCase) => {
    if (!itemId) return;
    const started = Date.now();
    const r = await runOne(caseRow);
    if (!r) return;
    try {
      await saveCaseRun({
        itemId,
        kind: "single",
        caseId: caseRow.id,
        environmentId: activeEnvironmentId,
        startedAt: started,
        entries: [{
          caseId: caseRow.id,
          caseName: caseRow.name,
          method: caseRow.request.method,
          url: caseRow.request.url,
          request: caseRow.request,
          result: r,
        }],
      });
      await refreshHistory(itemId);
    } catch (e) {
      message.warning(`运行记录保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Run All：并发 4 批量回归，整体聚合为一条 batch 历史（报告含全部用例） */
  const handleRunAll = async () => {
    if (runningAll || !cases?.length || !itemId) return;
    setRunningAll(true);
    const started = Date.now();
    const entries: {
      caseId: string;
      caseName: string;
      method: string;
      url: string;
      request: RequestCase["request"];
      result: ExecuteResult;
    }[] = [];
    try {
      const queue = [...cases];
      const workers = Array.from(
        { length: Math.min(4, queue.length) },
        async () => {
          let c: RequestCase | undefined;
          while ((c = queue.shift())) {
            const r = await runOne(c);
            if (r) {
              entries.push({
                caseId: c.id,
                caseName: c.name,
                method: c.request.method,
                url: c.request.url,
                request: c.request,
                result: r,
              });
            }
          }
        },
      );
      await Promise.all(workers);
    } finally {
      setRunningAll(false);
    }
    if (entries.length > 0) {
      // 按用例列表顺序归档（并发完成顺序不定）
      const order = new Map(cases.map((c, i) => [c.id, i]));
      entries.sort((a, b) => (order.get(a.caseId) ?? 0) - (order.get(b.caseId) ?? 0));
      try {
        await saveCaseRun({
          itemId,
          kind: "batch",
          environmentId: activeEnvironmentId,
          startedAt: started,
          entries,
        });
        await refreshHistory(itemId);
      } catch (e) {
        message.warning(`运行记录保存失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  /** New Case：服务端拷贝接口当前配置，创建后直接打开编辑 */
  const handleNewCase = async () => {
    if (!itemId || creating) return;
    setCreating(true);
    try {
      const created = await casesApi.create(itemId);
      upsert(created);
      openCase({ id: itemId, collectionId: tab.collectionId! }, created);
    } finally {
      setCreating(false);
    }
  };

  const handleRenameOk = async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) {
      message.warning("请输入用例名称");
      return;
    }
    const updated = await casesApi.update(renameTarget.id, { name });
    upsert(updated);
    renameTab(`case-${updated.id}`, name);
    setRenameTarget(null);
    message.success("已重命名");
  };

  const handleDuplicate = async (caseRow: RequestCase) => {
    if (!itemId) return;
    const created = await casesApi.create(itemId, {
      name: `${caseRow.name} Copy`,
      request: caseRow.request,
    });
    upsert(created);
    message.success("已复制用例");
  };

  const handleReset = (caseRow: RequestCase) => {
    modal.confirm({
      title: "从接口重新继承配置？",
      content: `将用接口当前配置覆盖「${caseRow.name}」，已有修改会丢失。`,
      okText: "重置",
      cancelText: "取消",
      onOk: async () => {
        const updated = await casesApi.reset(caseRow.id);
        upsert(updated);
        // 该用例的编辑 tab 已打开：同步内容与快照
        const caseTabKey = `case-${caseRow.id}`;
        if (useTabsStore.getState().tabs.some((t) => t.key === caseTabKey)) {
          replaceConfig(caseTabKey, updated.request);
          markSaved(caseTabKey, caseRow.itemId, tab.collectionId!, updated.name);
          setResponse(caseTabKey, null);
        }
        message.success("已从接口重新继承配置");
      },
    });
  };

  const handleDelete = (caseRow: RequestCase) => {
    modal.confirm({
      title: `删除用例「${caseRow.name}」？`,
      content: "删除后不可恢复。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        await casesApi.remove(caseRow.id);
        remove(caseRow.itemId, caseRow.id);
        closeTab(`case-${caseRow.id}`);
        message.success("已删除");
      },
    });
  };

  /** 汇总：已运行中通过 / 失败数与断言通过情况 */
  const summary = useMemo(() => {
    const ran = cases
      ?.map((c) => results[c.id])
      .filter((r): r is CaseRunState => !!r && !r.running && (r.status !== undefined || !!r.error));
    if (!ran?.length) return null;
    const passed = ran.filter((r) => r.passed).length;
    const testPassed = ran.reduce((n, r) => n + (r.testPassed ?? 0), 0);
    const testTotal = ran.reduce((n, r) => n + (r.testTotal ?? 0), 0);
    return { ran: ran.length, passed, failed: ran.length - passed, testPassed, testTotal };
  }, [cases, results]);

  if (!itemId) return null;

  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start", height: "100%" }}>
      {/* 左侧：运行历史（Run All 聚合一条 / 单条各一条） */}
      <CaseRunHistoryPanel
        records={history}
        onRecordLoaded={(jobId, results) =>
          setHistory((prev) =>
            prev.map((rec) => (rec.job.id === jobId ? { ...rec, results } : rec)),
          )
        }
      />

      {/* 右侧：工具栏 + 汇总 + 用例列表 */}
      <div style={{ flex: 1, minWidth: 0 }}>
      {/* 工具栏 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          用例在创建时继承该接口的完整配置，之后可独立修改、单独运行或批量回归。
        </Typography.Text>
        <span style={{ flex: 1 }} />
        <Button
          size="small"
          icon={<CaretRightOutlined />}
          onClick={() => void handleRunAll()}
          loading={runningAll}
          disabled={!cases?.length}
        >
          Run All
        </Button>
        <Button
          size="small"
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => void handleNewCase()}
          loading={creating}
        >
          New Case
        </Button>
      </div>

      {/* 汇总条（有运行结果时显示） */}
      {summary && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "6px 10px",
            marginBottom: 8,
            background: "#fafafa",
            border: "1px solid #f0f0f0",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            本次运行 {summary.ran}
          </Typography.Text>
          <Typography.Text style={{ fontSize: 12, color: "#52c41a" }}>
            ● {summary.passed} passed
          </Typography.Text>
          {summary.failed > 0 && (
            <Typography.Text style={{ fontSize: 12, color: "#ff4d4f" }}>
              ● {summary.failed} failed
            </Typography.Text>
          )}
          {summary.testTotal > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              · 断言 {summary.testPassed}/{summary.testTotal}
            </Typography.Text>
          )}
        </div>
      )}

      {/* 用例列表 */}
      {!cases ? (
        <div style={{ padding: 24, textAlign: "center" }}>
          <LoadingOutlined />
        </div>
      ) : cases.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有用例，点击 New Case 从接口当前配置创建一个"
        />
      ) : (
        <div style={{ border: "1px solid #f0f0f0", borderRadius: 6 }}>
          {cases.map((c, idx) => {
            const r = results[c.id];
            return (
              <div
                key={c.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 10px",
                  borderTop: idx === 0 ? "none" : "1px solid #f0f0f0",
                }}
              >
                {/* 运行状态点 */}
                {r?.running ? (
                  <LoadingOutlined style={{ fontSize: 10 }} />
                ) : (
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      flexShrink: 0,
                      background: !r
                        ? "rgba(0,0,0,0.15)"
                        : r.passed
                          ? "#52c41a"
                          : "#ff4d4f",
                    }}
                  />
                )}
                <Typography.Text
                  strong
                  style={{
                    fontSize: 12,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    flexShrink: 1,
                    minWidth: 0,
                  }}
                >
                  {c.name}
                </Typography.Text>
                <Typography.Text
                  type="secondary"
                  className="code-font"
                  style={{
                    fontSize: 11,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                    flexShrink: 1,
                  }}
                >
                  {c.description || `${c.request.method} ${c.request.url}`}
                </Typography.Text>
                <span style={{ flex: 1, minWidth: 8 }} />
                {/* 行内结果 */}
                {r && !r.running && (
                  <span
                    className="code-font"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 11,
                      flexShrink: 0,
                      maxWidth: "45%",
                      minWidth: 0,
                    }}
                  >
                    {r.error ? (
                      // 网络层错误原文透传但限宽省略，悬浮 Tooltip 看全文，避免撑宽页面
                      <Tooltip title={r.error} placement="topLeft">
                        <Typography.Text
                          type="danger"
                          style={{
                            fontSize: 11,
                            maxWidth: 220,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            display: "inline-block",
                          }}
                        >
                          {r.error}
                        </Typography.Text>
                      </Tooltip>
                    ) : (
                      <>
                        <span style={{ color: statusColor(r.status), fontWeight: 600 }}>
                          {r.status} {r.statusText}
                        </span>
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                          {r.durationMs}ms
                        </Typography.Text>
                      </>
                    )}
                    {r.testTotal! > 0 && (
                      <span style={{ color: r.testPassed === r.testTotal ? "#52c41a" : "#ff4d4f" }}>
                        {r.testPassed === r.testTotal ? "✓" : "✗"} {r.testPassed}/{r.testTotal}
                      </span>
                    )}
                  </span>
                )}
                {/* 行操作 */}
                <span style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
                  <Button
                    type="text"
                    size="small"
                    icon={<CaretRightOutlined />}
                    onClick={() => void handleRunSingle(c)}
                    disabled={r?.running}
                  >
                    Run
                  </Button>
                  <Button
                    type="text"
                    size="small"
                    onClick={() =>
                      openCase({ id: itemId, collectionId: tab.collectionId! }, c)
                    }
                  >
                    Open
                  </Button>
                  <Dropdown
                    trigger={["click"]}
                    menu={{
                      items: [
                        { key: "rename", icon: <EditOutlined />, label: "Rename" },
                        { key: "duplicate", icon: <CopyOutlined />, label: "Duplicate" },
                        {
                          key: "reset",
                          icon: <ReloadOutlined />,
                          label: "Reset from request",
                        },
                        { type: "divider" },
                        {
                          key: "delete",
                          icon: <DeleteOutlined />,
                          label: "Delete",
                          danger: true,
                        },
                      ],
                      onClick: ({ key, domEvent }) => {
                        domEvent.stopPropagation();
                        if (key === "rename") {
                          setRenameValue(c.name);
                          setRenameTarget(c);
                        } else if (key === "duplicate") {
                          void handleDuplicate(c);
                        } else if (key === "reset") {
                          handleReset(c);
                        } else if (key === "delete") {
                          handleDelete(c);
                        }
                      },
                    }}
                  >
                    <Button type="text" size="small" icon={<MoreOutlined />} />
                  </Dropdown>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* 重命名弹窗 */}
      <Modal
        title="重命名用例"
        open={renameTarget !== null}
        onOk={() => void handleRenameOk()}
        onCancel={() => setRenameTarget(null)}
        okText="保存"
        cancelText="取消"
        width={360}
      >
        <Input
          value={renameValue}
          maxLength={256}
          onChange={(e) => setRenameValue(e.target.value)}
          onPressEnter={() => void handleRenameOk()}
        />
      </Modal>
      </div>
    </div>
  );
}
