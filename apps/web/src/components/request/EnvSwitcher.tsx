import { Divider, Select } from "antd";
import { useAppStore } from "../../stores/app";

/** 环境切换器（位于请求标签行右侧，Postman 风格） */
export default function EnvSwitcher() {
  const environments = useAppStore((s) => s.environments);
  const activeEnvironmentId = useAppStore((s) => s.activeEnvironmentId);
  const setActiveEnvironment = useAppStore((s) => s.setActiveEnvironment);

  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      <Divider orientation="vertical" style={{ height: 20, marginInline: 8 }} />
      <Select
        size="small"
        variant="borderless"
        style={{ minWidth: 140 }}
        placeholder="No Environment"
        allowClear
        value={activeEnvironmentId}
        onChange={(v) => setActiveEnvironment(v ?? null)}
        options={environments.map((e) => ({ value: e.id, label: e.name }))}
      />
    </div>
  );
}
