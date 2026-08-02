/** 触发浏览器下载（Blob + a[download]） */
export function downloadText(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 下载指定 Run 的执行报告（JUnit XML / 自包含 HTML） */
export async function downloadRunReport(
  jobId: string,
  targetName: string,
  format: "junit" | "html",
  downloadReport: (jobId: string, format: "junit" | "html") => Promise<string>,
): Promise<void> {
  const content = await downloadReport(jobId, format);
  const safe = targetName.replace(/[^\w一-龥-]+/g, "_");
  downloadText(
    `rabbitpost-report-${safe}.${format === "junit" ? "xml" : "html"}`,
    content,
    format === "junit" ? "application/xml" : "text/html",
  );
}

/** 新标签页在线预览执行报告（inline HTML） */
export function previewRunReport(jobId: string): void {
  window.open(`/api/v1/runs/${jobId}/report?format=html&inline=1`, "_blank");
}
