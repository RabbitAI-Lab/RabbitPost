import { ArrowDownOutlined, ArrowUpOutlined, InfoCircleOutlined } from "@ant-design/icons";
import { Empty, Typography } from "antd";
import dayjs from "dayjs";
import { useEffect, useRef } from "react";

/** 长连接消息时间线条目（WebSocket / Socket.IO / MQTT / gRPC 流式通用） */
export interface MessageLogEntry {
  id: number;
  /** in=收到的消息，out=发出的消息，system=连接状态/错误等系统事件 */
  dir: "in" | "out" | "system";
  text: string;
  ts: number;
}

interface Props {
  entries: MessageLogEntry[];
  /** 各方向消息的着色（默认绿收蓝发），各协议可覆盖 */
  colors?: { in?: string; out?: string };
}

const DIR_META = {
  in: { icon: <ArrowDownOutlined />, defaultColor: "#52c41a", label: "收到" },
  out: { icon: <ArrowUpOutlined />, defaultColor: "#1677ff", label: "发出" },
  system: { icon: <InfoCircleOutlined />, defaultColor: "#8c8c8c", label: "系统" },
} as const;

/** 长连接协议通用的消息时间线：自动滚动到底，时间戳 + 方向着色（参考 Postman） */
export default function MessageLog({ entries, colors }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length]);

  if (entries.length === 0) {
    return (
      <div style={{ display: "flex", justifyContent: "center", paddingTop: 32 }}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<Typography.Text type="secondary">暂无消息</Typography.Text>}
        />
      </div>
    );
  }

  return (
    <div style={{ padding: "4px 0" }}>
      {entries.map((e) => {
        const meta = DIR_META[e.dir];
        const color =
          e.dir === "in"
            ? (colors?.in ?? meta.defaultColor)
            : e.dir === "out"
              ? (colors?.out ?? meta.defaultColor)
              : meta.defaultColor;
        return (
          <div
            key={e.id}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "baseline",
              padding: "3px 8px",
              borderBottom: "1px solid #f5f5f5",
              fontSize: 12,
            }}
          >
            <Typography.Text
              type="secondary"
              style={{ fontSize: 11, flexShrink: 0, width: 62 }}
              className="code-font"
            >
              {dayjs(e.ts).format("HH:mm:ss")}
            </Typography.Text>
            <span style={{ color, flexShrink: 0 }}>{meta.icon}</span>
            <Typography.Paragraph
              className="code-font"
              style={{ margin: 0, fontSize: 12, wordBreak: "break-all", whiteSpace: "pre-wrap" }}
              copyable={e.dir !== "system" ? { text: e.text, tooltips: false } : false}
            >
              {e.text}
            </Typography.Paragraph>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
