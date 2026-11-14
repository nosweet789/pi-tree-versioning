import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const diffParameters = Type.Object({
  scope: Type.Optional(Type.Unsafe<"workspace" | "turn" | "session">(StringEnum(["workspace", "turn", "session"], { description: "workspace (default): saved state to disk; turn: previous checkpoint to selected round; session: baseline to current saved state." }))),
  checkpointId: Type.Optional(Type.String({ description: "For turn scope only. Defaults to the nearest checkpoint on the current ancestry." })),
  files: Type.Optional(Type.Array(Type.String({ description: "Exact repository-relative file path." }))),
});
export type DiffInput = Static<typeof diffParameters>;

const fileState = Type.Union([
  Type.Null(),
  Type.Object({ kind: Type.Literal("file"), size: Type.Integer(), executable: Type.Boolean() }),
  Type.Object({ kind: Type.Literal("symlink"), target: Type.String(), targetEncoding: StringEnum(["utf8", "base64"]) }),
]);
const fileChange = Type.Object({
  path: Type.String(),
  status: StringEnum(["added", "deleted", "modified", "type_changed"]),
  before: fileState, after: fileState, binary: Type.Boolean(),
  additions: Type.Union([Type.Integer(), Type.Null()]),
  deletions: Type.Union([Type.Integer(), Type.Null()]),
  patch: Type.Optional(Type.String()),
});
const baselineEndpoint = Type.Object({
  kind: Type.Literal("baseline"), sessionId: Type.String(), workspaceRoot: Type.String(),
  id: Type.String(), capturedAt: Type.String(), anchorId: Type.Union([Type.String(), Type.Null()]),
});
const checkpointEndpoint = Type.Object({
  kind: Type.Literal("checkpoint"), sessionId: Type.String(), workspaceRoot: Type.String(),
  id: Type.String(), capturedAt: Type.String(), nodeId: Type.String(),
});
const queryError = Type.Object({
  status: Type.Literal("error"), code: Type.String(), diagnostic: Type.String(),
  diagnosticTruncated: Type.Boolean(),
  diagnosticPath: Type.Optional(Type.String()),
  diagnosticExportFailed: Type.Optional(Type.Boolean()),
});
export const checkpointsParameters = Type.Object({});
export type CheckpointsInput = Static<typeof checkpointsParameters>;
const catalog = {
  status: Type.Literal("ok"), sessionId: Type.String(), workspaceRoot: Type.String(),
  baseline: baselineEndpoint,
  current: Type.Object({ nodeId: Type.Union([Type.String(), Type.Null()]), snapshot: Type.Union([baselineEndpoint, checkpointEndpoint, Type.Null()]) }),
};
export const checkpointsOutput = Type.Union([
  Type.Object({ ...catalog, checkpoints: Type.Array(checkpointEndpoint) }),
  Type.Object({ ...catalog, output: Type.Object({ truncated: Type.Literal(true), fullOutputPath: Type.String(), totalCheckpoints: Type.Integer() }) }),
  queryError,
]);
const endpoints = {
  from: Type.Union([baselineEndpoint, checkpointEndpoint]),
  to: Type.Union([baselineEndpoint, checkpointEndpoint, Type.Object({ kind: Type.Literal("workspace"), workspaceRoot: Type.String() })]),
};

export const comparisonOutput = Type.Object({
  status: Type.Literal("ok"), scope: StringEnum(["workspace", "turn", "session"]), ...endpoints,
  files: Type.Array(fileChange),
});

export const diffOutput = Type.Union([
  comparisonOutput,
  Type.Object({
    status: Type.Literal("ok"), scope: StringEnum(["workspace", "turn", "session"]), ...endpoints,
    output: Type.Object({ truncated: Type.Literal(true), fullOutputPath: Type.String(), totalFiles: Type.Integer() }),
  }),
  queryError,
]);
