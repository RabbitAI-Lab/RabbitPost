import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = 3090;

/**
 * 检查端口是否被占用
 */
async function isPortInUse(port: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-i', `:${port}`, '-t'], {
      shell: false,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 获取占用端口的进程 PID
 */
async function getPidByPort(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-i', `:${port}`, '-t'], {
      shell: false,
    });
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((pid) => parseInt(pid, 10))
      .filter((pid) => !isNaN(pid));
  } catch {
    return [];
  }
}

/**
 * 获取进程信息
 */
async function getProcessInfo(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm='], {
      shell: false,
    });
    return stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 终止进程
 */
function killProcess(pid: number, force = false): boolean {
  try {
    const signal = force ? '-9' : '-15';
    execFileSync('kill', [signal, String(pid)], { shell: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * 等待端口释放
 */
async function waitForPortFree(port: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isPortInUse(port))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * 确保端口可用
 */
export async function ensurePort(port: number = DEFAULT_PORT): Promise<void> {
  console.log(`Checking port ${port}...`);

  if (!(await isPortInUse(port))) {
    console.log(`Port ${port} is available.`);
    return;
  }

  console.log(`Port ${port} is in use. Attempting to free it...`);

  const pids = await getPidByPort(port);
  if (pids.length === 0) {
    console.log(`No process found on port ${port}, but port is still in use.`);
    return;
  }

  for (const pid of pids) {
    const processName = await getProcessInfo(pid);
    console.log(`Found process: ${processName} (PID: ${pid})`);

    // 先尝试优雅终止
    console.log(`Sending SIGTERM to PID ${pid}...`);
    killProcess(pid, false);

    // 等待进程退出
    const freed = await waitForPortFree(port, 3000);
    if (freed) {
      console.log(`Port ${port} is now free.`);
      return;
    }

    // 如果还在占用，强制终止
    console.log(`Process still running, sending SIGKILL to PID ${pid}...`);
    killProcess(pid, true);

    const forceFreed = await waitForPortFree(port, 2000);
    if (forceFreed) {
      console.log(`Port ${port} is now free.`);
      return;
    }
  }

  // 最终检查
  if (await isPortInUse(port)) {
    throw new Error(`Failed to free port ${port}. Please manually kill the process using it.`);
  }

  console.log(`Port ${port} is ready.`);
}

/**
 * 主函数（直接运行时）
 */
async function main() {
  const port = parseInt(process.env.PORT || String(DEFAULT_PORT), 10);

  try {
    await ensurePort(port);
    process.exit(0);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  main();
}
