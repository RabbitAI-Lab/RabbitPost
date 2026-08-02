import { SearchOutlined } from "@ant-design/icons";
import { Empty, Input, Spin, Typography } from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { HistoryEntry } from "@rabbitpost/shared";
import { historyApi } from "../../api";
import { useAppStore } from "../../stores/app";
import { useTabsStore } from "../../stores/tabs";
import ChevronIcon from "../common/ChevronIcon";

/** Postman History 方法标签：8px 微缩字号 + 方法专属颜色 */
const METHOD_COLORS: Record<string, string> = {
  GET: "#247e4c",
  POST: "#a87d13",
  PUT: "#a87d13",
  PATCH: "#a87d13",
  DELETE: "#a87d13",
  HEAD: "#6b6b6b",
  OPTIONS: "#6b6b6b",
};

/** 按天分组的条目 */
type DayGroup = { key: string; label: string; entries: HistoryEntry[] };

/** 日期标签：今天 / 昨天 / 本年内 M月D日 / 跨年 YYYY年M月D日 */
function dayLabel(date: dayjs.Dayjs): string {
  const today = dayjs().startOf("day");
  const d = date.startOf("day");
  const diff = today.diff(d, "day");
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  if (d.year() === today.year()) return d.format("M月D日");
  return d.format("YYYY年M月D日");
}

/** 将历史按本地日期分组，组间按日期倒序、组内按时间倒序 */
function groupByDay(entries: HistoryEntry[]): DayGroup[] {
  // 先按 createdAt 倒序，保证组内时间从新到旧
  const sorted = [...entries].sort(
    (a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf(),
  );
  const groups: DayGroup[] = [];
  const indexByKey = new Map<string, number>();
  for (const entry of sorted) {
    const d = dayjs(entry.createdAt);
    const key = d.format("YYYY-MM-DD");
    let idx = indexByKey.get(key);
    if (idx === undefined) {
      idx = groups.length;
      groups.push({ key, label: dayLabel(d), entries: [] });
      indexByKey.set(key, idx);
    }
    // idx 此刻一定指向已存在的分组（新建或命中）
    groups[idx]!.entries.push(entry);
  }
  return groups;
}

export default function HistoryPanel({ visible = true }: { visible?: boolean }) {
  const currentWorkspaceId = useAppStore((s) => s.currentWorkspaceId);
  const openFromHistory = useTabsStore((s) => s.openFromHistory);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  // 按搜索词过滤后再按本地日期分组，组间 / 组内均按时间倒序
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? entries.filter(
          (e) =>
            (e.request.url ?? "").toLowerCase().includes(q) ||
            (e.request.method ?? "").toLowerCase().includes(q) ||
            (e.name ?? "").toLowerCase().includes(q),
        )
      : entries;
    return groupByDay(filtered);
  }, [entries, search]);
  // 折叠的天分组 key（YYYY-MM-DD）
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleDay = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const load = useCallback(
    async (silent = false) => {
      if (!currentWorkspaceId) {
        setEntries([]);
        return;
      }
      if (!silent) setLoading(true);
      try {
        setEntries(await historyApi.list(currentWorkspaceId));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [currentWorkspaceId],
  );

  // 首次挂载加载
  useEffect(() => {
    void load();
    // 发送请求后历史会更新，监听自定义事件刷新
    const handler = () => void load(true);
    window.addEventListener("rabbitpost:history-updated", handler);
    return () => window.removeEventListener("rabbitpost:history-updated", handler);
  }, [load]);

  // 每次切换到 History tab 时静默刷新
  useEffect(() => {
    if (visible) void load(true);
  }, [visible, load]);

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "8px 8px 0",
      }}
    >
      {/* 搜索框 */}
      <Input
        size="small"
        allowClear
        prefix={<SearchOutlined style={{ color: "#bbb" }} />}
        placeholder="搜索历史"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ flexShrink: 0, marginBottom: 8 }}
      />

      <div
        className="slim-scroll"
        style={{ flex: 1, minHeight: 0, overflow: "auto", paddingBottom: 8 }}
      >
      {groups.length === 0 ? (
        <Empty
          description={entries.length === 0 ? "暂无请求历史" : "无匹配结果"}
          style={{ marginTop: 24 }}
        />
      ) : (
        <Spin spinning={loading}>
          <div>
            {groups.map((group, gi) => {
              const isCollapsed = collapsed.has(group.key);
              return (
                <div key={group.key} style={gi > 0 ? { marginTop: 4 } : undefined}>
                  {/* 日期分组标题：点击折叠 / 展开 */}
                  <div
                    className="sidebar-hover"
                    onClick={() => toggleDay(group.key)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      cursor: "pointer",
                      padding: "8px 4px 4px",
                      userSelect: "none",
                    }}
                  >
                    <ChevronIcon open={!isCollapsed} size={12} />
                    <span style={{ fontSize: 12, fontWeight: 400, color: "#212121" }}>
                      {group.label}
                    </span>
                  </div>
                  {!isCollapsed &&
                    group.entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="sidebar-hover"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      cursor: "pointer",
                      padding: "6px 4px",
                      borderRadius: 4,
                    }}
                    onClick={() => openFromHistory(entry)}
                  >
                    <span
                      style={{
                        fontSize: 8,
                        fontWeight: 500,
                        color: METHOD_COLORS[entry.request.method] ?? "#6b6b6b",
                        flexShrink: 0,
                      }}
                    >
                      {entry.request.method}
                    </span>
                    <Typography.Text
                      ellipsis
                      style={{ flex: 1, fontSize: 12, color: "#212121" }}
                      title={entry.request.url}
                    >
                      {entry.request.url || entry.name || "-"}
                    </Typography.Text>
                  </div>
                ))}
              </div>
              );
            })}
          </div>
        </Spin>
      )}
      </div>
    </div>
  );
}
