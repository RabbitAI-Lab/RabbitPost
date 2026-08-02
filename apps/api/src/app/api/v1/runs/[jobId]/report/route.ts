import { asc, eq } from "drizzle-orm";
import { db } from "../../../../../../db";
import { runJobResults, runJobs } from "../../../../../../db/schema";
import { handleRoute, HttpError, requireTeamRole } from "../../../../../../lib/http";
import { toJunitXml, toHtmlReport } from "../../../../../../lib/report";
import { toRunJob, toRunJobResult } from "../../../../../../lib/runner";

type Ctx = { params: Promise<{ jobId: string }> };

/**
 * GET /api/v1/runs/:jobId/report?format=junit|html
 * 导出一次执行的报告：JUnit XML（CI 识别）或自包含 HTML（人看），viewer+。
 * 格式与 apps/cli 的 report.rs 对齐。
 */
export const GET = handleRoute<Ctx>(async (req, ctx, user) => {
  const { jobId } = await ctx.params;
  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "html";
  if (format !== "junit" && format !== "html") {
    throw new HttpError(400, "INVALID_FORMAT", "format must be junit or html");
  }
  // inline=1：Content-Disposition 用 inline，浏览器直接渲染（在线预览）而非下载
  const inline = url.searchParams.get("inline") === "1";

  const [job] = await db.select().from(runJobs).where(eq(runJobs.id, jobId)).limit(1);
  if (!job) throw new HttpError(404, "NOT_FOUND", "Run job not found");
  await requireTeamRole(job.teamId, user.id);

  const results = await db
    .select()
    .from(runJobResults)
    .where(eq(runJobResults.jobId, jobId))
    .orderBy(asc(runJobResults.createdAt));

  const jobDto = toRunJob(job);
  const resultDtos = results.map(toRunJobResult);
  // Content-Disposition 只能是 Latin-1：ASCII 回退名 + RFC 5987 UTF-8 编码名
  const ext = format === "junit" ? "xml" : "html";
  const asciiName = `rabbitpost-report-${jobId.slice(0, 8)}.${ext}`;
  const utf8Name = encodeURIComponent(`rabbitpost-report-${job.targetName}.${ext}`);
  const disposition = `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`;

  if (format === "junit") {
    return new Response(toJunitXml(jobDto, resultDtos), {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Content-Disposition": disposition,
      },
    });
  }
  return new Response(toHtmlReport(jobDto, resultDtos), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": disposition,
    },
  });
});
