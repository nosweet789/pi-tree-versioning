export type ErrorCode = "no_checkpoint" | "no_baseline" | "snapshot_unavailable" | "capture_failed" | "workspace_mismatch" |
  "invalid_request" | "unsupported_scope" | "storage_failed" | "query_failed";

export class VersioningError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); }
}
