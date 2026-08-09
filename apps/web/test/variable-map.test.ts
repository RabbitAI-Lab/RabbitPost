import { describe, expect, it } from "vitest";
import type { Environment, KeyValueItem } from "@rabbitpost/shared";
import { buildVariableMap } from "../src/lib/execute";

/** buildVariableMap：globals 垫底，Collection 覆盖，激活 Environment 最高 */

const kv = (key: string, value: string, enabled = true): KeyValueItem => ({
  id: key,
  key,
  value,
  enabled,
});

const env = (id: string, variables: Environment["variables"]): Environment => ({
  id,
  workspaceId: "ws1",
  name: id,
  variables,
  createdAt: "",
  updatedAt: "",
});

describe("buildVariableMap 变量优先级", () => {
  it("globals < collection < environment（同名高优先级覆盖）", () => {
    const vars = buildVariableMap({
      environmentId: "env1",
      environments: [env("env1", [kv("a", "env"), kv("b", "env"), kv("c", "env")])],
      collectionVariables: [kv("a", "col"), kv("b", "col"), kv("d", "col")],
      globalVariables: [kv("a", "global"), kv("e", "global")],
    });
    expect(vars).toEqual({
      a: "env",
      b: "env",
      c: "env",
      d: "col",
      e: "global",
    });
  });

  it("无环境时 collection 覆盖 globals", () => {
    const vars = buildVariableMap({
      environmentId: null,
      environments: [env("env1", [kv("a", "env")])],
      collectionVariables: [kv("a", "col")],
      globalVariables: [kv("a", "global"), kv("b", "global")],
    });
    expect(vars).toEqual({ a: "col", b: "global" });
  });

  it("globals 中禁用 / 空 key 的条目不生效", () => {
    const vars = buildVariableMap({
      environmentId: null,
      environments: [],
      globalVariables: [kv("a", "global", false), kv("", "no-key"), kv("b", "global")],
    });
    expect(vars).toEqual({ b: "global" });
  });

  it("不传 globals / collection 变量时行为与原来一致", () => {
    const vars = buildVariableMap({
      environmentId: "env1",
      environments: [env("env1", [kv("a", "env")])],
    });
    expect(vars).toEqual({ a: "env" });
  });
});
