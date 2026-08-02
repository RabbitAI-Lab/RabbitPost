import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  DeploymentUnitOutlined,
  DownOutlined,
  EditOutlined,
  HolderOutlined,
  ImportOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  RightOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import {
  App,
  Badge,
  Button,
  Checkbox,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CollectionItem,
  RunJob,
  RunJobResult,
  ScenarioStepWithDiff,
  StepDiffStatus,
} from "@rabbitpost/shared";
import { collectionsApi, runsApi, scenariosApi } from "../../api";
import { useAppStore } from "../../stores/app";
import { useTabsStore } from "../../stores/tabs";
import type { ScenarioTab } from "../../stores/tabs";

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
      }}
    >
      {method}
    </span>
  );
}

/** 差异状态标签 */
function DiffTag({ status }: { status: StepDiffStatus }) {
  if (status === "outdated") {
    return (
      <Tooltip title="源接口已更新，点击同步按钮获取最新配置">
        <Tag color="orange" style={{ marginRight: 4 }}>有差异</Tag>
      </Tooltip>
    );
  }
  if (status === "orphaned") {
    return (
      <Tooltip title="源接口已被删除，步骤将使用当前快照执行">
        <Tag color="red" style={{ marginRight: 4 }}>源已删除</Tag>
      </Tooltip>
    );
  }
  return null;
}

/** 场景测试编辑器主组件 */
export default function ScenarioEditor({ tab }: { tab: ScenarioTab }) {
  const { message } = App.useApp();
  const {
    currentWorkspaceId,
    currentTeamId,
    activeEnvironmentId,
  } = useAppStore();
  const { renameTab, openScenarioStep } = useTabsStore();

  const [steps, setSteps] = useState<ScenarioStepWithDiff[]>([]);
  const [loading, setLoading] = useState(false);
  const [scenarioName, setScenarioName] = useState(tab.name);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [syncAllModalOpen, setSyncAllModalOpen] = useState(false);
  const [running, setRunning] = useState(false);
  /** 当前执行的 job（轮询中） */
  const [activeJob, setActiveJob] = useState<RunJob | null>(null);
  /** 执行结果（逐步） */
  const [jobResults, setJobResults] = useState<RunJobResult[]>([]);
  /** 展开的步骤 id 集合 */
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const scenarioId = tab.scenarioId;
  const collectionId = tab.collectionId;

  /** 加载步骤列表 */
  const loadSteps = useCallback(async () => {
    try {
      setLoading(true);
      const data = await scenariosApi.listSteps(scenarioId);
      setSteps(data);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [scenarioId, message]);

  useEffect(() => {
    void loadSteps();
  }, [loadSteps]);

  // 注册步骤保存回调：RequestEditor 保存步骤后刷新列表
  useEffect(() => {
    const { setOnScenarioStepSaved } = useTabsStore.getState();
    setOnScenarioStepSaved(() => void loadSteps());
    return () => setOnScenarioStepSaved(null);
  }, [loadSteps]);

  // 组件卸载时停止轮询
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  /** 轮询任务状态 */
  const pollJob = useCallback(async (jobId: string) => {
    try {
      const detail = await runsApi.get(jobId);
      setActiveJob(detail.job);
      setJobResults(detail.results);
      if (detail.job.status === "succeeded" || detail.job.status === "failed" || detail.job.status === "canceled") {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setRunning(false);
      }
    } catch {
      // 轮询失败不阻塞
    }
  }, []);

  /** 保存场景名称 */
  const handleSaveName = async () => {
    if (!scenarioName.trim() || scenarioName === tab.name) return;
    try {
      await collectionsApi.updateItem(scenarioId, { name: scenarioName.trim() });
      renameTab(tab.key, scenarioName.trim());
      message.success("已保存");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  /** 编辑步骤：打开 RequestEditor tab（保存时写回 scenario_steps） */
  const handleEditStep = (step: ScenarioStepWithDiff) => {
    openScenarioStep(
      { id: step.id, name: step.name, request: step.request },
      { id: scenarioId, collectionId },
    );
  };

  /** 删除步骤 */
  const handleDeleteStep = async (stepId: string) => {
    try {
      await scenariosApi.deleteStep(stepId);
      setSteps((prev) => prev.filter((s) => s.id !== stepId));
      message.success("已删除");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  /** 同步单个步骤 */
  const handleSyncStep = async (stepId: string) => {
    try {
      await scenariosApi.syncStep(stepId);
      await loadSteps();
      message.success("已同步");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  /** 运行场景 */
  const handleRun = async () => {
    if (!currentTeamId || !currentWorkspaceId) {
      message.warning("请先选择 Workspace");
      return;
    }
    setRunning(true);
    setJobResults([]);
    try {
      const job = await runsApi.dispatch(currentTeamId, {
        workspaceId: currentWorkspaceId,
        targetType: "scenario",
        targetId: scenarioId,
        environmentId: activeEnvironmentId,
      });
      setActiveJob(job);
      message.success("场景已派发，等待 Runner 执行");
      // 开始轮询
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => void pollJob(job.id), 2000);
      // 立即执行一次
      void pollJob(job.id);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
  };

  /** 切换步骤展开/收起 */
  const toggleExpand = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  };

  const outdatedSteps = useMemo(
    () => steps.filter((s) => s.diffStatus === "outdated"),
    [steps],
  );

  /** 查找步骤对应的执行结果 */
  const resultForStep = (stepId: string): RunJobResult | undefined =>
    jobResults.find((r) => r.itemId === stepId);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 标题行 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 4px",
          flexShrink: 0,
        }}
      >
        <DeploymentUnitOutlined style={{ fontSize: 16, color: "#722ed1" }} />
        <Input
          size="small"
          value={scenarioName}
          onChange={(e) => setScenarioName(e.target.value)}
          onBlur={() => void handleSaveName()}
          onPressEnter={() => void handleSaveName()}
          style={{ width: 240, fontSize: 15, fontWeight: 600 }}
          bordered={false}
        />
        <div style={{ flex: 1 }} />
        <Button
          size="small"
          icon={<ImportOutlined />}
          onClick={() => setImportModalOpen(true)}
        >
          Add Step
        </Button>
        {outdatedSteps.length > 0 && (
          <Badge count={outdatedSteps.length} size="small">
            <Button
              size="small"
              icon={<SyncOutlined />}
              onClick={() => setSyncAllModalOpen(true)}
            >
              Sync All
            </Button>
          </Badge>
        )}
        <Button
          type="primary"
          size="small"
          icon={<PlayCircleOutlined />}
          loading={running}
          onClick={() => void handleRun()}
        >
          Run
        </Button>
      </div>

      {/* 执行状态条 */}
      {activeJob && (
        <div
          style={{
            padding: "4px 8px",
            background: activeJob.status === "succeeded" ? "#f6ffed" : activeJob.status === "failed" ? "#fff2f0" : "#e6f4ff",
            borderBottom: "1px solid #f0f0f0",
            fontSize: 12,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {activeJob.status === "running" || activeJob.status === "queued" ? (
            <LoadingOutlined spin style={{ color: "#1677ff" }} />
          ) : activeJob.status === "succeeded" ? (
            <CheckCircleOutlined style={{ color: "#52c41a" }} />
          ) : (
            <CloseCircleOutlined style={{ color: "#ff4d4f" }} />
          )}
          <span>
            {activeJob.status === "queued" && "排队中…"}
            {activeJob.status === "running" && `执行中 ${activeJob.succeededCount + activeJob.failedCount}/${activeJob.totalCount}`}
            {activeJob.status === "succeeded" && `全部通过（${activeJob.succeededCount}/${activeJob.totalCount}）`}
            {activeJob.status === "failed" && `执行失败（${activeJob.succeededCount} 成功，${activeJob.failedCount} 失败）`}
            {activeJob.status === "canceled" && "已取消"}
          </span>
        </div>
      )}

      {/* 步骤列表 */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 4px" }}>
        {loading ? (
          <div style={{ display: "grid", placeItems: "center", height: 200 }}>
            <Spin />
          </div>
        ) : steps.length === 0 ? (
          <Empty
            description="还没有步骤，点击下方按钮导入接口"
            style={{ marginTop: 48 }}
          />
        ) : (
          <StepList
            steps={steps}
            expandedSteps={expandedSteps}
            onToggleExpand={toggleExpand}
            onDelete={handleDeleteStep}
            onSync={handleSyncStep}
            onEdit={handleEditStep}
            onReorder={async (orderedIds) => {
              setSteps((prev) => {
                const map = new Map(prev.map((s) => [s.id, s]));
                return orderedIds
                  .map((id) => map.get(id))
                  .filter(Boolean) as ScenarioStepWithDiff[];
              });
              await scenariosApi.reorderSteps(scenarioId, orderedIds);
            }}
            resultForStep={resultForStep}
            onStepSaved={() => void loadSteps()}
          />
        )}
      </div>

      {/* 导入步骤弹窗 */}
      <ImportStepsModal
        open={importModalOpen}
        collectionId={collectionId}
        scenarioId={scenarioId}
        existingSourceIds={new Set(steps.map((s) => s.sourceItemId).filter(Boolean) as string[])}
        onClose={() => setImportModalOpen(false)}
        onImported={() => {
          setImportModalOpen(false);
          void loadSteps();
        }}
      />

      {/* 批量同步确认弹窗 */}
      <SyncAllModal
        open={syncAllModalOpen}
        outdatedSteps={outdatedSteps}
        scenarioId={scenarioId}
        onClose={() => setSyncAllModalOpen(false)}
        onSynced={() => {
          setSyncAllModalOpen(false);
          void loadSteps();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 步骤列表（拖拽排序 + 展开/收起 + 执行状态）
// ---------------------------------------------------------------------------

function StepList({
  steps,
  expandedSteps,
  onToggleExpand,
  onDelete,
  onSync,
  onEdit,
  onReorder,
  resultForStep,
  onStepSaved,
}: {
  steps: ScenarioStepWithDiff[];
  expandedSteps: Set<string>;
  onToggleExpand: (stepId: string) => void;
  onDelete: (stepId: string) => Promise<void>;
  onSync: (stepId: string) => Promise<void>;
  onEdit: (step: ScenarioStepWithDiff) => void;
  onReorder: (orderedIds: string[]) => Promise<void>;
  resultForStep: (stepId: string) => RunJobResult | undefined;
  onStepSaved: () => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const handleDragStart = (index: number) => setDragIndex(index);
  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === index) return;
    const ids = steps.map((s) => s.id);
    const [moved] = ids.splice(dragIndex, 1);
    ids.splice(index, 0, moved!);
    setDragIndex(index);
  };
  const handleDragEnd = async () => {
    if (dragIndex !== null) {
      await onReorder(steps.map((s) => s.id));
    }
    setDragIndex(null);
  };

  return (
    <div>
      {steps.map((step, index) => {
        const expanded = expandedSteps.has(step.id);
        const result = resultForStep(step.id);
        return (
          <div key={step.id}>
            {/* 步骤行 */}
            <div
              draggable
              onDragStart={() => handleDragStart(index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragEnd={() => void handleDragEnd()}
              onClick={() => onToggleExpand(step.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 8px",
                borderRadius: 4,
                marginBottom: 1,
                background: dragIndex === index ? "#f0f0f0" : "transparent",
                cursor: "pointer",
                border: "1px solid transparent",
              }}
            >
              <HolderOutlined
                style={{ color: "#bbb", cursor: "grab", flexShrink: 0 }}
                onClick={(e) => e.stopPropagation()}
              />
              <span
                style={{
                  width: 20,
                  textAlign: "center",
                  color: "#999",
                  fontSize: 12,
                  flexShrink: 0,
                }}
              >
                {index + 1}
              </span>
              {/* 执行状态图标 */}
              {result ? (
                result.ok ? (
                  <CheckCircleOutlined style={{ color: "#52c41a", flexShrink: 0 }} />
                ) : (
                  <CloseCircleOutlined style={{ color: "#ff4d4f", flexShrink: 0 }} />
                )
              ) : null}
              <MethodTag method={step.request?.method} />
              <Typography.Text ellipsis style={{ fontSize: 13, flex: 1 }}>
                {step.name}
              </Typography.Text>
              {step.sourceItemName && (
                <Typography.Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                  from {step.sourceItemName}
                </Typography.Text>
              )}
              <DiffTag status={step.diffStatus} />
              {result?.status && (
                <Tag style={{ flexShrink: 0 }}>{result.status}</Tag>
              )}
              {result?.durationMs != null && (
                <Typography.Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                  {result.durationMs}ms
                </Typography.Text>
              )}
              {step.diffStatus === "outdated" && (
                <Tooltip title="同步源接口最新配置">
                  <Button
                    type="text"
                    size="small"
                    icon={<SyncOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onSync(step.id);
                    }}
                  />
                </Tooltip>
              )}
              <Tooltip title="编辑请求配置">
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(step);
                  }}
                />
              </Tooltip>
              <Popconfirm
                title="删除步骤"
                description={`确定删除「${step.name}」吗？`}
                onConfirm={() => void onDelete(step.id)}
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
              >
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={(e) => e.stopPropagation()}
                />
              </Popconfirm>
              {expanded ? (
                <DownOutlined style={{ fontSize: 10, color: "#999", flexShrink: 0 }} />
              ) : (
                <RightOutlined style={{ fontSize: 10, color: "#999", flexShrink: 0 }} />
              )}
            </div>
            {/* 展开的请求配置摘要 */}
            {expanded && (
              <StepDetail step={step} result={result} onSaved={onStepSaved} onCollapse={() => onToggleExpand(step.id)} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 单字段左右对比行 */
function DiffRow({
  label,
  snapshotValue,
  sourceValue,
  changed,
}: {
  label: string;
  snapshotValue: string;
  sourceValue: string;
  changed: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 0,
        borderBottom: "1px solid #f0f0f0",
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      <div
        style={{
          width: 90,
          flexShrink: 0,
          padding: "4px 8px",
          color: "#999",
          fontSize: 11,
        }}
      >
        {label}
      </div>
      <div
        className="code-font"
        style={{
          flex: 1,
          minWidth: 0,
          padding: "4px 8px",
          wordBreak: "break-all",
          borderRight: "1px solid #f0f0f0",
        }}
      >
        {snapshotValue || <span style={{ color: "#ccc" }}>-</span>}
      </div>
      <div
        className="code-font"
        style={{
          flex: 1,
          minWidth: 0,
          padding: "4px 8px",
          wordBreak: "break-all",
          background: changed ? "#fff7e6" : "transparent",
          color: changed ? "#d48806" : "inherit",
          fontWeight: changed ? 600 : 400,
        }}
      >
        {sourceValue || <span style={{ color: "#ccc" }}>-</span>}
      </div>
    </div>
  );
}

/** 计算 Headers/Params 的对比摘要 */
function kvSummary(items: { key: string; value: string; enabled: boolean }[] | undefined): string {
  if (!items) return "-";
  const enabled = items.filter((i) => i.enabled && i.key);
  if (enabled.length === 0) return "-";
  return enabled.map((i) => `${i.key}: ${i.value}`).join("; ");
}

/** 步骤展开详情：请求配置摘要 + diff 对比 + 执行结果 */
function StepDetail({
  step,
  result,
  onSaved,
  onCollapse,
}: {
  step: ScenarioStepWithDiff;
  result?: RunJobResult;
  onSaved: () => void;
  onCollapse: () => void;
}) {
  const { message } = App.useApp();
  const [syncing, setSyncing] = useState(false);
  const req = step.request;
  const sourceReq = step.sourceRequest;
  const isOutdated = step.diffStatus === "outdated" && !!sourceReq;

  const handleSync = async () => {
    setSyncing(true);
    try {
      await scenariosApi.syncStep(step.id);
      message.success("已同步");
      onSaved();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div
      style={{
        margin: "0 8px 4px 36px",
        padding: "8px 12px",
        background: "#fafafa",
        borderRadius: 4,
        fontSize: 12,
        lineHeight: 1.8,
      }}
    >
      {/* diff 对比视图（outdated 时） */}
      {isOutdated ? (
        <div style={{ marginBottom: result ? 8 : 0 }}>
          {/* 表头 */}
          <div
            style={{
              display: "flex",
              gap: 0,
              borderBottom: "2px solid #e8e8e8",
              fontSize: 11,
              fontWeight: 600,
              color: "#999",
              padding: "4px 0",
            }}
          >
            <div style={{ width: 90, flexShrink: 0, padding: "0 8px" }}>字段</div>
            <div style={{ flex: 1, padding: "0 8px", borderRight: "1px solid #f0f0f0" }}>
              当前快照
            </div>
            <div style={{ flex: 1, padding: "0 8px" }}>源接口最新</div>
          </div>
          <DiffRow
            label="Method"
            snapshotValue={req?.method ?? "-"}
            sourceValue={sourceReq.method ?? "-"}
            changed={req?.method !== sourceReq.method}
          />
          <DiffRow
            label="URL"
            snapshotValue={req?.url ?? "-"}
            sourceValue={sourceReq.url ?? "-"}
            changed={req?.url !== sourceReq.url}
          />
          <DiffRow
            label="Headers"
            snapshotValue={kvSummary(req?.headers)}
            sourceValue={kvSummary(sourceReq.headers)}
            changed={kvSummary(req?.headers) !== kvSummary(sourceReq.headers)}
          />
          <DiffRow
            label="Params"
            snapshotValue={kvSummary(req?.params)}
            sourceValue={kvSummary(sourceReq.params)}
            changed={kvSummary(req?.params) !== kvSummary(sourceReq.params)}
          />
          <DiffRow
            label="Body"
            snapshotValue={req?.body?.raw ? (req.body.raw.length > 100 ? req.body.raw.slice(0, 100) + "…" : req.body.raw) : "-"}
            sourceValue={sourceReq.body?.raw ? (sourceReq.body.raw.length > 100 ? sourceReq.body.raw.slice(0, 100) + "…" : sourceReq.body.raw) : "-"}
            changed={req?.body?.raw !== sourceReq.body?.raw}
          />
          <DiffRow
            label="Auth"
            snapshotValue={req?.auth?.type ?? "none"}
            sourceValue={sourceReq.auth?.type ?? "none"}
            changed={req?.auth?.type !== sourceReq.auth?.type}
          />
          <DiffRow
            label="Pre-request"
            snapshotValue={req?.scripts?.preRequest ? "有" : "无"}
            sourceValue={sourceReq.scripts?.preRequest ? "有" : "无"}
            changed={!!req?.scripts?.preRequest !== !!sourceReq.scripts?.preRequest}
          />
          <DiffRow
            label="Tests"
            snapshotValue={req?.scripts?.test ? "有" : "无"}
            sourceValue={sourceReq.scripts?.test ? "有" : "无"}
            changed={!!req?.scripts?.test !== !!sourceReq.scripts?.test}
          />
          {/* 操作按钮 */}
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 8 }}>
            <Button size="small" onClick={onCollapse}>
              忽略
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<SyncOutlined />}
              loading={syncing}
              onClick={() => void handleSync()}
            >
              同步最新
            </Button>
          </div>
        </div>
      ) : (
        /* 单栏摘要（synced / orphaned） */
        <div style={{ marginBottom: result ? 8 : 0 }}>
          <div>
            <Typography.Text type="secondary">URL: </Typography.Text>
            <span className="code-font">{req?.url ?? "-"}</span>
          </div>
          {req?.headers && req.headers.filter((h) => h.enabled && h.key).length > 0 && (
            <div>
              <Typography.Text type="secondary">Headers: </Typography.Text>
              <span className="code-font">
                {req.headers
                  .filter((h) => h.enabled && h.key)
                  .map((h) => `${h.key}: ${h.value}`)
                  .join("; ")}
              </span>
            </div>
          )}
          {req?.body?.raw && (
            <div>
              <Typography.Text type="secondary">Body: </Typography.Text>
              <span className="code-font" style={{ wordBreak: "break-all" }}>
                {req.body.raw.length > 200 ? `${req.body.raw.slice(0, 200)}…` : req.body.raw}
              </span>
            </div>
          )}
          {req?.scripts?.preRequest && (
            <div>
              <Typography.Text type="secondary">Pre-request: </Typography.Text>
              <span className="code-font" style={{ wordBreak: "break-all" }}>
                {req.scripts.preRequest.length > 100 ? `${req.scripts.preRequest.slice(0, 100)}…` : req.scripts.preRequest}
              </span>
            </div>
          )}
          {req?.scripts?.test && (
            <div>
              <Typography.Text type="secondary">Tests: </Typography.Text>
              <span className="code-font" style={{ wordBreak: "break-all" }}>
                {req.scripts.test.length > 100 ? `${req.scripts.test.slice(0, 100)}…` : req.scripts.test}
              </span>
            </div>
          )}
        </div>
      )}
      {/* 执行结果 */}
      {result && (
        <div style={{ borderTop: "1px solid #e8e8e8", paddingTop: 8 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <Tag color={result.ok ? "success" : "error"}>
              {result.status ?? "ERR"} {result.statusText ?? ""}
            </Tag>
            {result.durationMs != null && (
              <Typography.Text type="secondary">{result.durationMs}ms</Typography.Text>
            )}
            {result.sizeBytes != null && (
              <Typography.Text type="secondary">{result.sizeBytes}B</Typography.Text>
            )}
          </div>
          {result.error && (
            <div style={{ color: "#ff4d4f", marginTop: 4 }}>{result.error}</div>
          )}
          {result.testResults && result.testResults.length > 0 && (
            <div style={{ marginTop: 4 }}>
              {result.testResults.map((t, i) => (
                <div key={i} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  {t.passed ? (
                    <CheckCircleOutlined style={{ color: "#52c41a", fontSize: 11 }} />
                  ) : (
                    <CloseCircleOutlined style={{ color: "#ff4d4f", fontSize: 11 }} />
                  )}
                  <span style={{ fontSize: 12 }}>{t.name}</span>
                  {t.error && (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      — {t.error}
                    </Typography.Text>
                  )}
                </div>
              ))}
            </div>
          )}
          {result.responseBody && (
            <div style={{ marginTop: 4 }}>
              <Typography.Text type="secondary">Response: </Typography.Text>
              <pre
                className="code-font"
                style={{
                  margin: 0,
                  padding: 4,
                  background: "#f0f0f0",
                  borderRadius: 2,
                  maxHeight: 120,
                  overflow: "auto",
                  fontSize: 11,
                  wordBreak: "break-all",
                  whiteSpace: "pre-wrap",
                }}
              >
                {result.responseBody.length > 500
                  ? `${result.responseBody.slice(0, 500)}…`
                  : result.responseBody}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 导入步骤弹窗
// ---------------------------------------------------------------------------

function ImportStepsModal({
  open,
  collectionId,
  scenarioId,
  existingSourceIds,
  onClose,
  onImported,
}: {
  open: boolean;
  collectionId: string;
  scenarioId: string;
  existingSourceIds: Set<string>;
  onClose: () => void;
  onImported: () => void;
}) {
  const { message } = App.useApp();
  const { collectionTrees } = useAppStore();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  // 从 collectionTrees 中提取所有 request 类型的条目
  const requestItems = useMemo(() => {
    const tree = collectionTrees[collectionId] ?? [];
    const result: (CollectionItem & { path: string })[] = [];
    const walk = (items: CollectionItem[], prefix: string) => {
      for (const item of items) {
        const path = prefix ? `${prefix} / ${item.name}` : item.name;
        if (item.type === "request") {
          result.push({ ...item, path });
        }
        if (item.children) walk(item.children, path);
      }
    };
    walk(tree, "");
    return result;
  }, [collectionTrees, collectionId]);

  const handleImport = async () => {
    if (selectedIds.size === 0) return;
    setImporting(true);
    try {
      for (const sourceItemId of selectedIds) {
        await scenariosApi.addStep(scenarioId, { sourceItemId });
      }
      message.success(`已导入 ${selectedIds.size} 个步骤`);
      onImported();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      title="导入接口为步骤"
      open={open}
      onCancel={onClose}
      onOk={() => void handleImport()}
      okText={`导入 (${selectedIds.size})`}
      cancelText="取消"
      confirmLoading={importing}
      destroyOnHidden
    >
      <div style={{ maxHeight: 400, overflow: "auto" }}>
        {requestItems.length === 0 ? (
          <Empty description="该 Collection 下没有接口" />
        ) : (
          requestItems.map((item) => (
            <div
              key={item.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 0",
              }}
            >
              <Checkbox
                checked={selectedIds.has(item.id)}
                disabled={existingSourceIds.has(item.id)}
                onChange={(e) => {
                  const next = new Set(selectedIds);
                  if (e.target.checked) {
                    next.add(item.id);
                  } else {
                    next.delete(item.id);
                  }
                  setSelectedIds(next);
                }}
              />
              <MethodTag method={item.request?.method} />
              <span style={{ fontSize: 13 }}>{item.path}</span>
              {existingSourceIds.has(item.id) && (
                <Tag style={{ marginLeft: "auto" }}>已导入</Tag>
              )}
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 字段级差异计算
// ---------------------------------------------------------------------------

/** 计算两个 RequestConfig 之间的字段级差异描述 */
function computeDiffSummary(
  snapshot: ScenarioStepWithDiff["request"],
  source: ScenarioStepWithDiff["request"],
): string[] {
  const diffs: string[] = [];
  if (!snapshot || !source) return diffs;

  if (snapshot.method !== source.method) {
    diffs.push(`Method: ${snapshot.method} → ${source.method}`);
  }
  if (snapshot.url !== source.url) {
    diffs.push(`URL 已变更`);
  }
  // Headers 对比
  const oldHeaders = new Map((snapshot.headers ?? []).filter((h) => h.enabled && h.key).map((h) => [h.key, h.value]));
  const newHeaders = new Map((source.headers ?? []).filter((h) => h.enabled && h.key).map((h) => [h.key, h.value]));
  const addedHeaders = [...newHeaders.keys()].filter((k) => !oldHeaders.has(k));
  const removedHeaders = [...oldHeaders.keys()].filter((k) => !newHeaders.has(k));
  const changedHeaders = [...newHeaders.keys()].filter((k) => oldHeaders.has(k) && oldHeaders.get(k) !== newHeaders.get(k));
  if (addedHeaders.length > 0) diffs.push(`Headers 新增 ${addedHeaders.length} 项`);
  if (removedHeaders.length > 0) diffs.push(`Headers 移除 ${removedHeaders.length} 项`);
  if (changedHeaders.length > 0) diffs.push(`Headers 修改 ${changedHeaders.length} 项`);
  // Params 对比
  const oldParams = new Map((snapshot.params ?? []).filter((p) => p.enabled && p.key).map((p) => [p.key, p.value]));
  const newParams = new Map((source.params ?? []).filter((p) => p.enabled && p.key).map((p) => [p.key, p.value]));
  const addedParams = [...newParams.keys()].filter((k) => !oldParams.has(k));
  const removedParams = [...oldParams.keys()].filter((k) => !newParams.has(k));
  if (addedParams.length > 0) diffs.push(`Params 新增 ${addedParams.length} 项`);
  if (removedParams.length > 0) diffs.push(`Params 移除 ${removedParams.length} 项`);
  // Body 对比
  if (snapshot.body?.raw !== source.body?.raw) {
    diffs.push("Body 已变更");
  }
  // Auth 对比
  if (JSON.stringify(snapshot.auth) !== JSON.stringify(source.auth)) {
    diffs.push("Authorization 已变更");
  }
  // Scripts 对比
  if (snapshot.scripts?.preRequest !== source.scripts?.preRequest) {
    diffs.push("Pre-request 脚本已变更");
  }
  if (snapshot.scripts?.test !== source.scripts?.test) {
    diffs.push("Tests 脚本已变更");
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// 批量同步确认弹窗
// ---------------------------------------------------------------------------

function SyncAllModal({
  open,
  outdatedSteps,
  scenarioId,
  onClose,
  onSynced,
}: {
  open: boolean;
  outdatedSteps: ScenarioStepWithDiff[];
  scenarioId: string;
  onClose: () => void;
  onSynced: () => void;
}) {
  const { message } = App.useApp();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set(outdatedSteps.map((s) => s.id)),
  );
  const [syncing, setSyncing] = useState(false);

  // 每次打开时重置选中
  useEffect(() => {
    if (open) {
      setSelectedIds(new Set(outdatedSteps.map((s) => s.id)));
    }
  }, [open, outdatedSteps]);

  const handleSyncAll = async () => {
    if (selectedIds.size === 0) return;
    setSyncing(true);
    try {
      const result = await scenariosApi.syncAllSteps(scenarioId, [...selectedIds]);
      if (result.failed.length > 0) {
        message.warning(
          `同步完成：${result.synced.length} 成功，${result.failed.length} 失败`,
        );
      } else {
        message.success(`已同步 ${result.synced.length} 个步骤`);
      }
      onSynced();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Modal
      title="批量同步步骤"
      open={open}
      onCancel={onClose}
      onOk={() => void handleSyncAll()}
      okText={`确认同步 (${selectedIds.size})`}
      cancelText="取消"
      confirmLoading={syncing}
      width={560}
      destroyOnHidden
    >
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
        以下步骤的源接口已更新，同步后将用最新配置覆盖当前快照（本地修改将丢失）：
      </Typography.Text>
      <div style={{ maxHeight: 400, overflow: "auto" }}>
        {outdatedSteps.map((step) => {
          const diffs = step.sourceRequest
            ? computeDiffSummary(step.request, step.sourceRequest)
            : [];
          return (
            <div
              key={step.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "8px 0",
                borderBottom: "1px solid #f5f5f5",
              }}
            >
              <Checkbox
                checked={selectedIds.has(step.id)}
                onChange={(e) => {
                  const next = new Set(selectedIds);
                  if (e.target.checked) {
                    next.add(step.id);
                  } else {
                    next.delete(step.id);
                  }
                  setSelectedIds(next);
                }}
                style={{ marginTop: 2 }}
              />
              <MethodTag method={step.request?.method} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13 }}>{step.name}</div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  源接口：{step.sourceItemName ?? "未知"}
                </Typography.Text>
                {diffs.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    {diffs.map((d, i) => (
                      <Tag key={i} style={{ fontSize: 11, marginBottom: 2 }}>
                        {d}
                      </Tag>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
