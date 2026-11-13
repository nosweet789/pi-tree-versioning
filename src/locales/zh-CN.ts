import type { en } from "./en.ts";

export const zhCN: Record<keyof typeof en, string> = {
  languageCommand: "选择文件版本扩展的语言",
  languageHelp: "用法：/tree-versioning-language en | zh-CN | auto。当前语言偏好：{preference}。",
  languageSaved: "语言偏好已保存：{preference}。",
  baselineCreated: "已记录会话基线。可用 session_diff 查询未入快照的差异。",
  startupFailed: "基线不可用，未记录新基线。{reason}",
  diffLabel: "会话差异",
  comparison: "未入快照差异：基线 → 磁盘工作区（{count} 个文件）。",
  no_baseline: "当前会话位置没有适用基线，未进行比较。",
  snapshot_unavailable: "已保存的基线缺失、不可读或已损坏，未重新建立基线。",
  capture_failed: "工作区采集失败，未返回不完整的比较结果。",
  workspace_mismatch: "已保存的基线属于其他会话或工作区。",
  invalid_request: "文件筛选必须使用安全的仓库相对路径。",
  unsupported_scope: "此开发版本仅支持工作区差异查询。",
  storage_failed: "基线存储失败，未发布完整基线。",
  query_failed: "差异比较失败。",
  diagnosticTruncated: "底层诊断信息已截断。完整诊断：{path}",
  diagnosticExportFailed: "诊断信息已截断，无法安全导出完整内容。上方仍为原始错误说明。",
  preferences_failed: "无法读取或保存扩展的语言偏好。",
  outputTruncated: "输出已截断至 2000 行 / 50 KiB。完整比较：{path}",
};
