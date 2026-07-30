/**
 * Postman 风格脚本沙箱（node:vm 实现，超时 5s）。
 * 提供 rp.environment / rp.variables / rp.request / rp.response / rp.test / rp.expect / console，
 * 其中 rp 为 RabbitPost 命名，pm 作为兼容别名保留。
 */
import vm from "node:vm";
import type {
  ConsoleLogEntry,
  TestResult,
  VariableMap,
} from "@rabbitpost/shared";

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

export function runUserScript(options: {
  code: string;
  phase: "pre-request" | "test";
  variables: VariableMap;
  request?: SandboxRequestView;
  response?: SandboxResponseView;
}): SandboxRunResult {
  const { code, phase } = options;
  const variables: VariableMap = { ...options.variables };
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

  const result: SandboxRunResult = { testResults, consoleLogs, variables };

  try {
    const context = vm.createContext(
      // rp 为主命名，pm 兼容旧脚本（同一对象）
      { rp: pm, pm, console: capturedConsole },
      { name: `rabbitpost-${phase}` },
    );
    new vm.Script(code, { filename: `${phase}.js` }).runInContext(context, {
      timeout: SCRIPT_TIMEOUT_MS,
    });
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    consoleLogs.push({ level: "error", args: [`[${phase}] ${result.error}`] });
  }

  if (pmRequest) result.request = pmRequest;
  return result;
}
