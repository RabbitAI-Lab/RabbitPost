#!/usr/bin/env node
/**
 * 启动前确保开发端口可用：若被占用则终止占用进程。
 *
 * 用法：
 *   node scripts/ensure-ports.mjs            # 清理默认端口 [5173, 4000]
 *   node scripts/ensure-ports.mjs 5173 4000  # 清理指定端口
 *
 * 环境变量：
 *   DEV_PORTS="5173,4000"  覆盖默认端口列表
 *   PORT_KILL=0            只检查不杀进程（占用时退出码为 1）
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_PORTS = [5173, 4000];
const KILL_ENABLED = process.env.PORT_KILL !== '0';

function parsePorts() {
  const fromArgs = process.argv.slice(2).map((v) => parseInt(v, 10));
  const fromEnv = (process.env.DEV_PORTS || '')
    .split(',')
    .map((v) => parseInt(v.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  const ports = fromArgs.length > 0 ? fromArgs : fromEnv.length > 0 ? fromEnv : DEFAULT_PORTS;
  return [...new Set(ports)].filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
}

async function pidsOnPort(port) {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t']);
    return stdout
      .trim()
      .split('\n')
      .map((v) => parseInt(v, 10))
      .filter((n) => Number.isInteger(n));
  } catch {
    return []; // lsof 无匹配时退出码为 1
  }
}

async function processName(pid) {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm=']);
    return stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function kill(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPortFree(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await pidsOnPort(port)).length === 0) return true;
    await sleep(100);
  }
  return false;
}

async function ensurePort(port) {
  const pids = await pidsOnPort(port);
  if (pids.length === 0) {
    console.log(`[ensure-ports] port ${port} is free`);
    return true;
  }

  const names = [];
  for (const pid of pids) names.push(`${await processName(pid)}(pid=${pid})`);
  console.log(`[ensure-ports] port ${port} occupied by: ${names.join(', ')}`);

  if (!KILL_ENABLED) {
    console.error(`[ensure-ports] PORT_KILL=0, refusing to kill. Please free port ${port} manually.`);
    return false;
  }

  // 先 SIGTERM 优雅退出，不行再 SIGKILL
  for (const pid of pids) kill(pid, 'SIGTERM');
  if (await waitPortFree(port, 3000)) {
    console.log(`[ensure-ports] port ${port} freed (SIGTERM)`);
    return true;
  }

  for (const pid of await pidsOnPort(port)) kill(pid, 'SIGKILL');
  if (await waitPortFree(port, 2000)) {
    console.log(`[ensure-ports] port ${port} freed (SIGKILL)`);
    return true;
  }

  console.error(`[ensure-ports] failed to free port ${port}`);
  return false;
}

const ports = parsePorts();
const results = await Promise.all(ports.map(ensurePort));
if (results.every(Boolean)) {
  console.log(`[ensure-ports] all ports ready: ${ports.join(', ')}`);
  process.exit(0);
} else {
  process.exit(1);
}
