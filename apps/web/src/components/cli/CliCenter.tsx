import { Tabs } from "antd";
import { useTabsStore, type CliSection, type CliTab } from "../../stores/tabs";
import RabbitPostCliPanel from "./RabbitPostCliPanel";
import RunnerAdminPanel from "./RunnerAdminPanel";
import RunnerCliPanel from "./RunnerCliPanel";

interface Props {
  tab: CliTab;
}

/**
 * CLI 中心：RabbitPost CLI、Runner 管理（注册与 Token）与 Runner CLI（安装引导）
 * 三块内容共用一个工作 tab；Runner CLI 与 RabbitPost CLI 是两个独立的程序。
 */
export default function CliCenter({ tab }: Props) {
  const setCliSection = useTabsStore((s) => s.setCliSection);

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "12px 16px" }}>
      <Tabs
        size="small"
        activeKey={tab.section}
        onChange={(key) => setCliSection(tab.key, key as CliSection)}
        items={[
          {
            key: "rabbitpost-cli" satisfies CliSection,
            label: "RabbitPost CLI",
            children: <RabbitPostCliPanel />,
          },
          {
            key: "runner-admin" satisfies CliSection,
            label: "Runner 管理",
            children: <RunnerAdminPanel />,
          },
          {
            key: "runner-cli" satisfies CliSection,
            label: "Runner CLI",
            children: <RunnerCliPanel />,
          },
        ]}
      />
    </div>
  );
}
