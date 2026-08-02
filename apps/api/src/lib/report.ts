/**
 * 执行报告生成：JUnit XML（CI 识别）与自包含 HTML（人看），
 * 与 apps/cli/src/report.rs 的格式对齐（同一套 testsuite/testcase 语义与转义规则）。
 */
import type { RunJob, RunJobResult } from "@rabbitpost/shared";

/** XML/HTML 文本转义（与 CLI esc 一致） */
export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cdata(text: string): string {
  // CDATA 内不允许出现 "]]>"，拆开转义
  return `<![CDATA[${text.replace(/\]\]>/g, "]]>]]&gt;<![CDATA[")}]]>`;
}

export interface ReportMeta {
  targetName: string;
  targetType: string;
  environmentName: string | null;
  agent: string | null;
  startedAt: string;
  finishedAt: string;
}

export function metaFromJob(job: RunJob): ReportMeta {
  return {
    targetName: job.targetName,
    targetType: job.targetType,
    environmentName: job.environmentName,
    agent: job.agent ?? job.runnerName ?? "rabbitpost",
    startedAt: job.claimedAt ?? job.createdAt,
    finishedAt: job.finishedAt ?? job.createdAt,
  };
}

function durationSec(job: RunJob): number {
  const start = new Date(job.claimedAt ?? job.createdAt).getTime();
  const end = new Date(job.finishedAt ?? job.createdAt).getTime();
  return Math.max(0, end - start) / 1000;
}

/** JUnit XML：每个用例一个 testcase；失败时附错误与失败断言明细 */
export function toJunitXml(job: RunJob, results: RunJobResult[]): string {
  const meta = metaFromJob(job);
  const total = results.length;
  const failed = results.filter((r) => !r.ok).length;
  const time = durationSec(job).toFixed(3);

  let out = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  out += `<testsuites name="rabbitpost" tests="${total}" failures="${failed}" time="${time}">\n`;
  out += `  <testsuite name="${esc(meta.targetName)}" tests="${total}" failures="${failed}" time="${time}">\n`;

  for (const r of results) {
    const caseName = `${r.method} ${r.name}`;
    const caseTime = ((r.durationMs ?? 0) / 1000).toFixed(3);
    const tests = r.testResults ?? [];
    const logs = r.consoleLogs ?? [];
    const hasDetails = !r.ok || tests.length > 0 || logs.length > 0;

    if (!hasDetails) {
      out += `    <testcase classname="${esc(meta.targetName)}" name="${esc(caseName)}" time="${caseTime}"/>\n`;
      continue;
    }
    out += `    <testcase classname="${esc(meta.targetName)}" name="${esc(caseName)}" time="${caseTime}">\n`;

    if (!r.ok) {
      const failedTests = tests
        .filter((t) => !t.passed)
        .map((t) => `✗ ${t.name}${t.error ? ` — ${t.error}` : ""}`);
      const message = r.error ?? `${failedTests.length} assertion(s) failed`;
      let detail = "";
      if (r.error) detail += `${r.error}\n`;
      detail += failedTests.join("\n");
      out += `      <failure message="${esc(message)}">${cdata(detail)}</failure>\n`;
    }

    let notes = "";
    for (const t of tests) {
      notes += `${t.passed ? "✓" : "✗"} ${t.name}${t.error ? ` — ${t.error}` : ""}\n`;
    }
    for (const log of logs) {
      notes += `[${log.level}] ${log.args.join(" ")}\n`;
    }
    if (notes) out += `      <system-out>${cdata(notes)}</system-out>\n`;
    out += `    </testcase>\n`;
  }

  out += `  </testsuite>\n</testsuites>\n`;
  return out;
}

/** 自包含 HTML：头部汇总卡片 + 逐用例 <details>（断言与 console 明细），无外部依赖 */
export function toHtmlReport(job: RunJob, results: RunJobResult[]): string {
  const meta = metaFromJob(job);
  const total = results.length;
  const succeeded = results.filter((r) => r.ok).length;
  const failed = total - succeeded;
  const testsPassed = results.reduce(
    (n, r) => n + (r.testResults ?? []).filter((t) => t.passed).length,
    0,
  );
  const testsFailed = results.reduce(
    (n, r) => n + (r.testResults ?? []).filter((t) => !t.passed).length,
    0,
  );
  const durationMs = Math.round(durationSec(job) * 1000);
  const statusText = failed === 0 ? "PASSED" : "FAILED";
  const statusColor = failed === 0 ? "#16a34a" : "#dc2626";

  let rows = "";
  for (const r of results) {
    const badge = r.ok
      ? '<span class="badge pass">PASS</span>'
      : '<span class="badge fail">FAIL</span>';
    const status = r.status !== null ? String(r.status) : "—";
    const duration = r.durationMs !== null ? `${r.durationMs} ms` : "—";

    // 请求参数（执行时的请求配置快照）
    let detail = "";
    if (r.request) {
      const req = r.request;
      detail += '<div class="section"><div class="section-title">请求</div>';
      detail += `<div class="url">${esc(req.method)} ${esc(req.url)}</div>`;
      const enabledParams = (req.params ?? []).filter((p) => p.enabled && p.key);
      if (enabledParams.length > 0) {
        detail += '<div class="kv"><span class="kv-label">Query Params</span>';
        for (const p of enabledParams) detail += `<div class="kv-row">${esc(p.key)} = ${esc(p.value)}</div>`;
        detail += "</div>";
      }
      const enabledHeaders = (req.headers ?? []).filter((h) => h.enabled && h.key);
      if (enabledHeaders.length > 0) {
        detail += '<div class="kv"><span class="kv-label">Headers</span>';
        for (const h of enabledHeaders) detail += `<div class="kv-row">${esc(h.key)}: ${esc(h.value)}</div>`;
        detail += "</div>";
      }
      if (req.body && req.body.type !== "none") {
        const bodyText =
          req.body.type === "raw"
            ? (req.body.raw ?? "")
            : req.body.type === "graphql"
              ? (req.body.graphqlQuery ?? "")
              : `[${req.body.type}]`;
        if (bodyText) detail += `<pre class="body">${esc(bodyText)}</pre>`;
      }
      detail += "</div>";
    } else {
      detail += `<div class="url">${esc(r.url)}</div>`;
    }

    // 执行错误（网络层/脚本错误，原文透传）
    if (r.error) {
      detail += `<div class="section"><div class="section-title error-title">错误</div><div class="error">${esc(r.error)}</div></div>`;
    }

    // 响应（状态码 + 响应头 + 响应体）
    if (r.status !== null || r.responseBody || r.responseHeaders) {
      detail += '<div class="section"><div class="section-title">响应</div>';
      if (r.status !== null) {
        detail += `<div class="resp-status">${r.status}${r.statusText ? ` ${esc(r.statusText)}` : ""}${r.durationMs !== null ? ` · ${r.durationMs} ms` : ""}</div>`;
      }
      const respHeaders = Object.entries(r.responseHeaders ?? {});
      if (respHeaders.length > 0) {
        detail += '<div class="kv">';
        for (const [k, v] of respHeaders) detail += `<div class="kv-row">${esc(k)}: ${esc(v)}</div>`;
        detail += "</div>";
      }
      if (r.responseBody) detail += `<pre class="body">${esc(r.responseBody)}</pre>`;
      detail += "</div>";
    }

    // 断言执行结果
    const tests = r.testResults ?? [];
    if (tests.length > 0) {
      detail += '<div class="section"><div class="section-title">断言</div><table class="tests"><tbody>';
      for (const t of tests) {
        const cls = t.passed ? "pass-text" : "fail-text";
        const mark = t.passed ? "✓" : "✗";
        const err = t.error ? `<div class="error small">${esc(t.error)}</div>` : "";
        detail += `<tr><td class="${cls}">${mark}</td><td>${esc(t.name)}${err}</td></tr>`;
      }
      detail += "</tbody></table></div>";
    }

    // 脚本 console 输出
    const logs = r.consoleLogs ?? [];
    if (logs.length > 0) {
      detail += '<div class="section"><div class="section-title">Console</div><pre class="logs">';
      for (const log of logs) {
        detail += `[${esc(log.level)}] ${esc(log.args.join(" "))}\n`;
      }
      detail += "</pre></div>";
    }

    rows += `<details class="case${r.ok ? "" : " failed"}"><summary>${badge} <span class="method">${esc(r.method)}</span> ${esc(r.name)} <span class="meta">${status} · ${duration}</span></summary>${detail}</details>\n`;
  }

  const environment = meta.environmentName ?? "—";

  // 环境变量快照（执行时存，secret 已脱敏）；有才展示
  let envBlock = "";
  const envSnapshot = job.environmentSnapshot ?? [];
  if (envSnapshot.length > 0) {
    let rows2 = "";
    for (const v of envSnapshot) {
      const dim = v.enabled ? "" : ' style="opacity:0.45"';
      rows2 += `<div class="env-row"${dim}><span class="env-key">${esc(v.key)}</span><span class="env-eq">=</span><span class="env-val">${esc(v.value)}</span></div>`;
    }
    envBlock = `<details class="env"><summary>环境快照 · ${esc(environment)}（${envSnapshot.length} 个变量）</summary><div class="env-body">${rows2}</div></details>`;
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>RabbitPost 测试报告 · ${esc(meta.targetName)}</title>
<style>
  body { font-family: -apple-system, "SF Pro", "PingFang SC", sans-serif; margin: 0; background: #f7f7f8; color: #1f2329; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #6b7280; font-size: 13px; margin-bottom: 20px; }
  .cards { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 18px; min-width: 110px; }
  .card .num { font-size: 22px; font-weight: 600; }
  .card .label { color: #6b7280; font-size: 12px; }
  .status { color: #fff; background: ${statusColor}; border-radius: 6px; padding: 2px 10px; font-size: 13px; font-weight: 600; }
  .case { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 8px; padding: 10px 14px; }
  .case.failed { border-color: #fecaca; }
  summary { cursor: pointer; font-size: 14px; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  .method { font-weight: 600; color: #ea580c; margin: 0 6px; }
  .meta { color: #6b7280; font-size: 12px; float: right; }
  .badge { border-radius: 4px; padding: 1px 8px; font-size: 12px; font-weight: 600; }
  .badge.pass { background: #dcfce7; color: #16a34a; }
  .badge.fail { background: #fee2e2; color: #dc2626; }
  .url { color: #6b7280; font-size: 12px; word-break: break-all; margin: 8px 0; }
  .error { color: #dc2626; font-size: 13px; margin: 6px 0; white-space: pre-wrap; }
  .error.small { font-size: 12px; }
  table.tests { width: 100%; border-collapse: collapse; margin: 6px 0; font-size: 13px; }
  table.tests td { padding: 3px 8px; border-top: 1px solid #f3f4f6; }
  .pass-text { color: #16a34a; width: 24px; }
  .fail-text { color: #dc2626; width: 24px; }
  pre.logs { background: #111827; color: #d1d5db; border-radius: 6px; padding: 10px 12px; font-size: 12px; overflow: auto; }
  .section { margin-top: 10px; }
  .section-title { font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 4px; }
  .section-title.error-title { color: #dc2626; }
  .kv { font-size: 12px; margin: 4px 0; }
  .kv-label { color: #6b7280; font-size: 11px; }
  .kv-row { font-family: ui-monospace, monospace; color: #374151; padding: 1px 0; word-break: break-all; }
  .resp-status { font-family: ui-monospace, monospace; font-size: 12px; font-weight: 600; margin: 4px 0; }
  pre.body { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px 10px; font-size: 12px; overflow: auto; max-height: 320px; white-space: pre-wrap; word-break: break-all; }
  .env { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 16px; padding: 8px 14px; }
  .env summary { font-size: 13px; font-weight: 600; color: #374151; }
  .env-body { margin-top: 6px; }
  .env-row { display: flex; gap: 8px; font-family: ui-monospace, monospace; font-size: 12px; line-height: 22px; }
  .env-key { color: #1f2329; font-weight: 600; }
  .env-eq { color: #9ca3af; }
  .env-val { color: #374151; word-break: break-all; }
</style>
</head>
<body>
<div class="wrap">
  <h1>RabbitPost 测试报告 <span class="status">${statusText}</span></h1>
  <div class="sub">${esc(meta.targetName)} · 环境 ${esc(environment)} · ${esc(meta.targetType)} · ${esc(meta.agent ?? "rabbitpost")} 执行 · ${esc(meta.startedAt)} → ${esc(meta.finishedAt)}</div>
  <div class="cards">
    <div class="card"><div class="num">${total}</div><div class="label">用例总数</div></div>
    <div class="card"><div class="num" style="color:#16a34a">${succeeded}</div><div class="label">成功</div></div>
    <div class="card"><div class="num" style="color:#dc2626">${failed}</div><div class="label">失败</div></div>
    <div class="card"><div class="num">${testsPassed} / ${testsFailed}</div><div class="label">断言通过 / 失败</div></div>
    <div class="card"><div class="num">${durationMs} ms</div><div class="label">总耗时</div></div>
  </div>
  ${envBlock}
  ${rows}
</div>
</body>
</html>
`;
}
