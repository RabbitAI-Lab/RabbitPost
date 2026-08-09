import { useMemo } from "react";
import { useAppStore } from "../../../stores/app";
import type { EnvVarMap } from "./var-segments";

/**
 * 当前可见的变量表（仅启用条目）：globals 垫底、激活环境变量覆盖；
 * 所有变量高亮组件共用，保证与 Send 替换一致
 */
export function useEnvVars(): EnvVarMap {
  const environments = useAppStore((s) => s.environments);
  const activeEnvironmentId = useAppStore((s) => s.activeEnvironmentId);
  const workspaces = useAppStore((s) => s.workspaces);
  const currentWorkspaceId = useAppStore((s) => s.currentWorkspaceId);
  return useMemo(() => {
    const map: EnvVarMap = {};
    const ws = workspaces.find((w) => w.id === currentWorkspaceId);
    for (const v of ws?.variables ?? []) {
      if (v.enabled && v.key) map[v.key] = { value: v.value };
    }
    const env = environments.find((e) => e.id === activeEnvironmentId);
    for (const v of env?.variables ?? []) {
      if (v.enabled && v.key) map[v.key] = { value: v.value, secret: v.secret };
    }
    return map;
  }, [environments, activeEnvironmentId, workspaces, currentWorkspaceId]);
}
