/**
 * 内嵌 Runner 生命周期管理：随 API 服务启动/停止，自动注册到平台。
 * 外部 Runner 优先：有活跃外部 Runner 时，任务优先派发给他们。
 */
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { runners } from "../db/schema";
import { issueRunnerToken } from "./runner";

/** 内嵌 Runner 保留名（随 API 服务自动启停，不可通过 API 手动管理） */
export const EMBEDDED_RUNNER_NAME = "__embedded__";

/** 是否为内嵌 Runner：其记录随服务生命周期托管，禁止改名 / 启停 / 删除 / 重置 Token */
export function isEmbeddedRunner(name: string): boolean {
  return name === EMBEDDED_RUNNER_NAME;
}
const HEARTBEAT_TIMEOUT_MS = 90_000; // 90秒无心跳视为离线

let runnerProcess: ChildProcess | null = null;
let embeddedRunnerId: string | null = null;
let embeddedRunnerToken: string | null = null;
let restartTimer: NodeJS.Timeout | null = null;

/** 判断 Runner 是否在线（最近 90 秒有心跳） */
function isRunnerOnline(lastSeenAt: Date | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - lastSeenAt.getTime() < HEARTBEAT_TIMEOUT_MS;
}

/**
 * 获取或创建内嵌 Runner 记录。
 * 每个团队一个内嵌 Runner，随 API 服务启动自动注册。
 */
async function ensureEmbeddedRunner(teamId: string, createdBy: string): Promise<{
  runnerId: string;
  token: string;
}> {
  // 查找现有内嵌 Runner
  const [existing] = await db
    .select()
    .from(runners)
    .where(and(eq(runners.teamId, teamId), eq(runners.name, EMBEDDED_RUNNER_NAME)))
    .limit(1);

  if (existing) {
    // 已有记录：重置 Token（旧 Token 可能已泄露或丢失）
    const { token, tokenHash, tokenPrefix } = issueRunnerToken();
    await db
      .update(runners)
      .set({ tokenHash, tokenPrefix, status: "active", updatedAt: new Date() })
      .where(eq(runners.id, existing.id));
    return { runnerId: existing.id, token };
  }

  // 创建新记录
  const { token, tokenHash, tokenPrefix } = issueRunnerToken();
  const [runner] = await db
    .insert(runners)
    .values({
      teamId,
      name: EMBEDDED_RUNNER_NAME,
      description: "Embedded runner started with API server",
      tokenHash,
      tokenPrefix,
      status: "active",
      createdBy,
    })
    .returning();

  if (!runner) throw new Error("Failed to create embedded runner");
  return { runnerId: runner.id, token };
}

/**
 * 启动内嵌 Runner 进程。
 * @param teamId 默认团队 ID（内嵌 Runner 所属团队）
 * @param createdBy 系统用户 ID（Runner 创建者）
 */
export async function startEmbeddedRunner(teamId: string, createdBy: string): Promise<void> {
  if (runnerProcess) {
    console.log("[embedded-runner] already running");
    return;
  }

  // 默认使用 API 目录下的 runner 二进制（由 postbuild 脚本复制）
  const runnerPath = process.env.RUNNER_BINARY_PATH ||
    (process.env.NODE_ENV === "production" ? "./rabbitpost-runner" : "../runner/target/release/rabbitpost-runner");

  // 二进制缺失时降级：不注册内嵌 Runner，避免在 DB 留下离线的 active 记录被
  // selectRunnerForJob 误选（导致 dispatchAndWait 轮询超时、前端卡在"请求发送中"），
  // 也避免无意义的 spawn → exit → restart 循环刷日志。单请求 Send 会自动回退到服务端直接执行。
  if (!existsSync(runnerPath)) {
    console.warn(
      `[embedded-runner] binary not found at ${runnerPath}; embedded runner disabled. ` +
        `Requests will fall back to server-side execution. Build it with: cd apps/runner && cargo build --release`,
    );
    return;
  }

  const { runnerId, token } = await ensureEmbeddedRunner(teamId, createdBy);
  embeddedRunnerId = runnerId;
  embeddedRunnerToken = token;

  const serverUrl = process.env.API_INTERNAL_URL || "http://localhost:4000";

  console.log(`[embedded-runner] starting with server=${serverUrl}`);

  runnerProcess = spawn(
    runnerPath,
    [
      "serve",
      "--server", serverUrl,
      "--token", token,
      "--concurrency", "8",
      "--poll-interval", "1", // 内嵌模式更频繁轮询，减少延迟
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RABBITPOST_SERVER: serverUrl,
        RABBITPOST_RUNNER_TOKEN: token,
      },
    },
  );

  runnerProcess.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[embedded-runner] ${line}`);
  });

  runnerProcess.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.error(`[embedded-runner] ${line}`);
  });

  runnerProcess.on("error", (err) => {
    console.error("[embedded-runner] failed to start:", err.message);
    scheduleRestart(teamId, createdBy);
  });

  runnerProcess.on("exit", (code, signal) => {
    console.log(`[embedded-runner] exited with code=${code} signal=${signal}`);
    runnerProcess = null;
    scheduleRestart(teamId, createdBy);
  });

  console.log("[embedded-runner] started");
}

function scheduleRestart(teamId: string, createdBy: string): void {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    console.log("[embedded-runner] restarting...");
    void startEmbeddedRunner(teamId, createdBy);
  }, 5000);
}

/** 停止内嵌 Runner */
export function stopEmbeddedRunner(): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (runnerProcess) {
    console.log("[embedded-runner] stopping...");
    runnerProcess.kill("SIGTERM");
    runnerProcess = null;
  }
  embeddedRunnerId = null;
  embeddedRunnerToken = null;
}

/** 获取内嵌 Runner ID（用于任务派发时排除） */
export function getEmbeddedRunnerId(): string | null {
  return embeddedRunnerId;
}

// ---------------------------------------------------------------------------
// Runner 选择策略：外部 Runner 优先
// ---------------------------------------------------------------------------

export interface SelectedRunner {
  id: string;
  name: string;
  isEmbedded: boolean;
}

/**
 * 为任务选择 Runner：外部在线 Runner 优先，否则使用内嵌 Runner。
 * Runner 全局共享，不按团队隔离——任何团队的请求都可被任意在线 Runner 领取。
 * @param teamId 团队 ID（保留签名兼容，不再用于过滤）
 * @returns 选中的 Runner，或 null（无可用 Runner）
 */
export async function selectRunnerForJob(_teamId: string): Promise<SelectedRunner | null> {
  // 拉取所有 active Runner，统一以 lastSeenAt 心跳判断是否在线。
  // 注意：status='active' 仅代表记录启用，不代表进程存活——Runner 崩溃或二进制
  // 缺失时记录仍为 active，必须用心跳时间二次校验，否则任务会被派发给已死的
  // Runner，导致 dispatchAndWait 轮询超时（前端表现为"请求发送中"一直卡住）。
  const candidates = await db
    .select()
    .from(runners)
    .where(eq(runners.status, "active"))
    .orderBy(desc(runners.lastSeenAt));

  // 1. 优先选择在线的外部 Runner（非内嵌）
  const onlineExternal = candidates.find(
    (r) => r.name !== EMBEDDED_RUNNER_NAME && isRunnerOnline(r.lastSeenAt),
  );
  if (onlineExternal) {
    return { id: onlineExternal.id, name: onlineExternal.name, isEmbedded: false };
  }

  // 2. 其次选择内嵌 Runner：仅当本进程已 spawn 且其心跳在线时才可用。
  //    内嵌 Runner 刚启动的短暂冷启动窗口内（尚未上报心跳）会降级到服务端直接执行。
  if (embeddedRunnerId) {
    const embedded = candidates.find((r) => r.id === embeddedRunnerId);
    if (embedded && isRunnerOnline(embedded.lastSeenAt)) {
      return {
        id: embedded.id,
        name: EMBEDDED_RUNNER_NAME,
        isEmbedded: true,
      };
    }
  }

  // 3. 兜底：团队内其他在线 Runner
  const onlineAny = candidates.find((r) => isRunnerOnline(r.lastSeenAt));
  if (onlineAny) {
    return {
      id: onlineAny.id,
      name: onlineAny.name,
      isEmbedded: onlineAny.name === EMBEDDED_RUNNER_NAME,
    };
  }

  return null;
}

/**
 * 检查团队是否有可用 Runner（在线外部 Runner 或内嵌 Runner）。
 */
export async function hasAvailableRunner(teamId: string): Promise<boolean> {
  const selected = await selectRunnerForJob(teamId);
  return selected !== null;
}
