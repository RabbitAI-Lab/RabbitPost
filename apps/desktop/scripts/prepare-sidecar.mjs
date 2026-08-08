#!/usr/bin/env node
/**
 * 构建 rabbitpost-runner 并按 Tauri externalBin 约定复制为
 * src-tauri/bin/rabbitpost-runner-<target-triple>[.exe]。
 * cargo 增量构建，重复执行开销很小。
 */
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const runnerDir = join(desktopDir, "..", "runner");

const hostInfo = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const triple = hostInfo.match(/^host: (\S+)$/m)?.[1];
if (!triple) throw new Error("无法从 rustc -vV 解析 target triple");

const isWin = process.platform === "win32";
const exe = isWin ? ".exe" : "";

console.log(`[sidecar] 构建 rabbitpost-runner（release）…`);
execSync("cargo build --release --locked", { cwd: runnerDir, stdio: "inherit" });

const outDir = join(desktopDir, "src-tauri", "bin");
mkdirSync(outDir, { recursive: true });
const src = join(runnerDir, "target", "release", `rabbitpost-runner${exe}`);
const dest = join(outDir, `rabbitpost-runner-${triple}${exe}`);
copyFileSync(src, dest);
console.log(`[sidecar] ${dest}`);
