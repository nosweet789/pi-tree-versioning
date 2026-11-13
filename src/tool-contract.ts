import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const diffParameters = Type.Object({
  scope: Type.Optional(Type.Literal("workspace", { description: "Only workspace comparisons are currently implemented." })),
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
const endpoints = {
  from: Type.Object({
    kind: Type.Literal("baseline"), sessionId: Type.String(), workspaceRoot: Type.String(),
    id: Type.String(), capturedAt: Type.String(), anchorId: Type.Union([Type.String(), Type.Null()]),
  }),
  to: Type.Object({ kind: Type.Literal("workspace"), workspaceRoot: Type.String() }),
};

export const diffOutput = Type.Union([
  Type.Object({
    status: Type.Literal("ok"), scope: Type.Literal("workspace"), ...endpoints,
    files: Type.Array(fileChange),
  }),
  Type.Object({
    status: Type.Literal("ok"), scope: Type.Literal("workspace"), ...endpoints,
    output: Type.Object({ truncated: Type.Literal(true), fullOutputPath: Type.String(), totalFiles: Type.Integer() }),
  }),
  Type.Object({
    status: Type.Literal("error"), code: Type.String(), diagnostic: Type.String(),
    diagnosticTruncated: Type.Boolean(),
    diagnosticPath: Type.Optional(Type.String()),
    diagnosticExportFailed: Type.Optional(Type.Boolean()),
  }),
]);
