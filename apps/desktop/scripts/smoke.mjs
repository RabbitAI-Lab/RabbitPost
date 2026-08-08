/**
 * desktop 冒烟检查：配置一致性（CI/本地均可跑，无需构建）。
 * 用法：pnpm --filter @rabbitpost/desktop test
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const r = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    failures++;
    console.error(`❌ ${name} ${extra}`);
  }
};

// 1. tauri.conf.json 可解析且关键字段齐备
const conf = JSON.parse(readFileSync(r("src-tauri/tauri.conf.json"), "utf8"));
const win = conf.app?.windows?.[0];
check("tauri.conf.json 可解析", !!conf);
check("主窗口 URL 已配置", typeof win?.url === "string" && win.url.length > 0, win?.url);
check(
  "externalBin 声明 runner sidecar",
  (conf.bundle?.externalBin ?? []).includes("bin/rabbitpost-runner"),
);

// 2. sidecar 准备脚本与 externalBin 命名一致
const sidecarSrc = existsSync(r("scripts/prepare-sidecar.mjs"))
  ? readFileSync(r("scripts/prepare-sidecar.mjs"), "utf8")
  : "";
check("prepare-sidecar.mjs 存在", sidecarSrc.length > 0);
check(
  "sidecar 脚本产物名与 externalBin 一致",
  sidecarSrc.includes("rabbitpost-runner"),
);

// 3. capabilities 存在且语法合法
const cap = JSON.parse(readFileSync(r("src-tauri/capabilities/default.json"), "utf8"));
check("capabilities/default.json 可解析", !!cap);

// 4. lib.rs 含 local-agent spawn 与退出清理
const libRs = readFileSync(r("src-tauri/src/lib.rs"), "utf8");
check("lib.rs spawn local-agent", libRs.includes("local-agent"));
check("lib.rs 退出时清理子进程", libRs.includes("kill"));

console.log(failures === 0 ? "\nDESKTOP SMOKE PASS ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
