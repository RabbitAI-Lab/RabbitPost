/**
 * Postman 风格脚本沙箱（node:vm 实现，超时 5s）。
 * 提供 rp.environment / rp.variables / rp.request / rp.response / rp.test / rp.expect / console，
 * 其中 rp 为 RabbitPost 命名，pm 作为兼容别名保留。
 */
import vm from "node:vm";
import type {
  ConsoleLogEntry,
  DbExecResult,
  DbQueryResult,
  TestResult,
  VariableMap,
} from "@rabbitpost/shared";

/** 沙箱内 rp.db 依赖的最小接口（由 lib/db-client.ts 的 DbExecutor 结构满足） */
export interface SandboxDbExecutor {
  query(name: string, sql: string, params?: unknown[]): Promise<DbQueryResult>;
  exec(name: string, sql: string, params?: unknown[]): Promise<DbExecResult>;
  redis(name: string, command: string, args?: string[]): Promise<unknown>;
  mongo(name: string, command: Record<string, unknown>): Promise<unknown>;
}

export interface SandboxRequestView {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface SandboxResponseView {
  code: number;
  status: string;
  headers: Record<string, string>;
  time: number;
  bodyText: string;
}

export interface SandboxRunResult {
  testResults: TestResult[];
  consoleLogs: ConsoleLogEntry[];
  /** 脚本执行期间的变量改动（仅本次请求生命周期内生效） */
  variables: VariableMap;
  /** 脚本执行后的 globals 表（rp.globals 作用域；调用方未传入时为空表） */
  globals: VariableMap;
  /** pre-request 脚本可能改写请求 */
  request?: SandboxRequestView;
  error?: string;
}

const SCRIPT_TIMEOUT_MS = 5000;

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 极简 chai 风格断言：pm.expect(x).to.equal(...) / .include(...) / .eql(...) / .be.ok 等 */
function makeExpect() {
  const expectFn = (actual: unknown) => {
    const fail = (msg: string): never => {
      throw new Error(`AssertionError: ${msg}`);
    };
    const assertions = {
      equal(expected: unknown) {
        if (actual !== expected) {
          fail(`expected ${safeStringify(actual)} to equal ${safeStringify(expected)}`);
        }
      },
      eql(expected: unknown) {
        if (safeStringify(actual) !== safeStringify(expected)) {
          fail(`expected ${safeStringify(actual)} to deeply equal ${safeStringify(expected)}`);
        }
      },
      include(part: unknown) {
        const ok =
          (typeof actual === "string" && actual.includes(String(part))) ||
          (Array.isArray(actual) && actual.includes(part));
        if (!ok) fail(`expected ${safeStringify(actual)} to include ${safeStringify(part)}`);
      },
      above(n: number) {
        if (!(typeof actual === "number" && actual > n)) {
          fail(`expected ${safeStringify(actual)} to be above ${n}`);
        }
      },
      below(n: number) {
        if (!(typeof actual === "number" && actual < n)) {
          fail(`expected ${safeStringify(actual)} to be below ${n}`);
        }
      },
      oneOf(list: unknown[]) {
        if (!list.includes(actual)) {
          fail(`expected ${safeStringify(actual)} to be one of ${safeStringify(list)}`);
        }
      },
      exist() {
        if (actual === null || actual === undefined) fail("expected value to exist");
      },
    };
    return {
      to: { ...assertions, be: {
        ok() { if (!actual) fail(`expected ${safeStringify(actual)} to be ok`); },
        true() { if (actual !== true) fail(`expected ${safeStringify(actual)} to be true`); },
        false() { if (actual !== false) fail(`expected ${safeStringify(actual)} to be false`); },
        ...assertions,
      } },
    };
  };
  return expectFn;
}

/** rp.db API：未注入执行器时同步抛错（在 async IIFE 内转为脚本错误，与脚本异常同路径） */
function makeDbApi(executor?: SandboxDbExecutor) {
  const noDb = (): never => {
    throw new Error("rp.db: no database connections configured for this execution");
  };
  return {
    query: (name: string, sql: string, params?: unknown[]): Promise<DbQueryResult> =>
      executor ? executor.query(name, sql, params) : noDb(),
    exec: (name: string, sql: string, params?: unknown[]): Promise<DbExecResult> =>
      executor ? executor.exec(name, sql, params) : noDb(),
    redis: (name: string, command: string, args?: string[]): Promise<unknown> =>
      executor ? executor.redis(name, command, args) : noDb(),
    /** MongoDB runCommand：command 接受对象或 JSON 字符串 */
    mongo: (name: string, command: Record<string, unknown> | string): Promise<unknown> => {
      if (!executor) return noDb();
      let parsed: Record<string, unknown>;
      if (typeof command === "string") {
        try {
          parsed = JSON.parse(command) as Record<string, unknown>;
        } catch {
          throw new Error("rp.db.mongo: command is not valid JSON");
        }
      } else {
        parsed = command;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("rp.db.mongo: command must be an object or a JSON object string");
      }
      return executor.mongo(name, parsed);
    },
  };
}

export async function runUserScript(options: {
  code: string;
  phase: "pre-request" | "test";
  variables: VariableMap;
  /** globals 作用域（可选；服务端一次性执行不持久化，仅保证 rp.globals API 可用） */
  globals?: VariableMap;
  request?: SandboxRequestView;
  response?: SandboxResponseView;
  /** 数据库执行器（可选；未提供时 rp.db.* 抛出“未配置数据库连接”错误） */
  db?: SandboxDbExecutor;
}): Promise<SandboxRunResult> {
  const { code, phase } = options;
  const variables: VariableMap = { ...options.variables };
  const globals: VariableMap = { ...options.globals };
  const testResults: TestResult[] = [];
  const consoleLogs: ConsoleLogEntry[] = [];

  const capturedConsole = Object.fromEntries(
    (["log", "info", "warn", "error"] as const).map((level) => [
      level,
      (...args: unknown[]) => {
        consoleLogs.push({ level, args: args.map(safeStringify) });
      },
    ]),
  );

  const pmRequest = options.request
    ? {
        method: options.request.method,
        url: options.request.url,
        headers: { ...options.request.headers },
        body: options.request.body,
      }
    : undefined;

  const pm: Record<string, unknown> = {
    environment: {
      get: (key: string) => variables[key],
      set: (key: string, value: unknown) => {
        variables[key] = safeStringify(value);
      },
      unset: (key: string) => {
        delete variables[key];
      },
      toObject: () => ({ ...variables }),
    },
    variables: {
      get: (key: string) => variables[key],
      set: (key: string, value: unknown) => {
        variables[key] = safeStringify(value);
      },
    },
    globals: {
      get: (key: string) => globals[key],
      set: (key: string, value: unknown) => {
        globals[key] = safeStringify(value);
      },
      unset: (key: string) => {
        delete globals[key];
      },
      toObject: () => ({ ...globals }),
    },
    test: (name: string, fn: () => void) => {
      try {
        fn();
        testResults.push({ name, passed: true });
      } catch (e) {
        testResults.push({
          name,
          passed: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    expect: makeExpect(),
    // rp.db：异步宿主函数；vm 同步执行，await 的宿主 Promise 在 vm 外解析，不会死锁
    db: makeDbApi(options.db),
  };

  if (pmRequest) pm.request = pmRequest;
  if (options.response) {
    const resp = options.response;
    pm.response = {
      code: resp.code,
      status: resp.status,
      headers: resp.headers,
      time: resp.time,
      json: () => JSON.parse(resp.bodyText),
      text: () => resp.bodyText,
      to: {
        have: {
          status: (expected: number) => {
            if (resp.code !== expected) {
              throw new Error(
                `AssertionError: expected response status ${resp.code} to be ${expected}`,
              );
            }
          },
        },
      },
    };
  }

  const result: SandboxRunResult = { testResults, consoleLogs, variables, globals };

  try {
    const context = vm.createContext(
      // rp 为主命名，pm 兼容旧脚本（同一对象）
      { rp: pm, pm, console: capturedConsole },
      { name: `rabbitpost-${phase}` },
    );
    // 包成 async IIFE 使顶层 await（如 rp.db.query）可用；同步旧脚本行为不变
    const script = new vm.Script(`(async () => {\n${code}\n})()`, {
      filename: `${phase}.js`,
    });
    // vm timeout 只覆盖同步 CPU 段；异步等待由外层 Promise.race 超时兜底
    const promise = script.runInContext(context, {
      timeout: SCRIPT_TIMEOUT_MS,
    }) as Promise<unknown>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Script execution timed out after ${SCRIPT_TIMEOUT_MS}ms`)),
        SCRIPT_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      // 超时后脚本 Promise 可能稍后拒绝，吞掉避免 unhandledRejection
      promise.catch(() => {});
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    consoleLogs.push({ level: "error", args: [`[${phase}] ${result.error}`] });
  }

  if (pmRequest) result.request = pmRequest;
  return result;
}
