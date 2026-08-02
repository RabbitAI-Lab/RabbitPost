import type { RpCollectionFile } from "@rabbitpost/shared";

// 交换格式的构建 / 解析实现位于 shared 包，这里转导出，
// 使侧栏组件统一从本地 lib/collection-file 导入（与下载 / 分享工具同出一处）
export { buildCollectionFile, parseCollectionFile } from "@rabbitpost/shared";
export type { RpCollectionNode } from "@rabbitpost/shared";

/** 文件名安全化：去掉路径与 Windows 保留字符 */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned || "collection";
}

/** 触发浏览器下载导出文件 */
export function downloadCollectionFile(file: RpCollectionFile) {
  const blob = new Blob([JSON.stringify(file, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeFileName(file.name)}.rabbitpost.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** 分享链接：公开只读，直接返回 RabbitPost Collection JSON */
export function shareUrl(token: string): string {
  return `${window.location.origin}/api/v1/public/collections/${token}`;
}
