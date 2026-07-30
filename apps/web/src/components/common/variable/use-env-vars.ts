import { useMemo } from "react";
import { useAppStore } from "../../../stores/app";
import type { EnvVarMap } from "./var-segments";

/** 当前激活环境变量表（仅启用条目）；所有变量高亮组件共用，保证与 Send 替换一致 */
export function useEnvVars(): EnvVarMap {
  const environments = useAppStore((s) => s.environments);
  const activeEnvironmentId = useAppStore((s) => s.activeEnvironmentId);
  return useMemo(() => {
    const env = environments.find((e) => e.id === activeEnvironmentId);
    const map: EnvVarMap = {};
    for (const v of env?.variables ?? []) {
      if (v.enabled && v.key) map[v.key] = { value: v.value, secret: v.secret };
    }
    return map;
  }, [environments, activeEnvironmentId]);
}
