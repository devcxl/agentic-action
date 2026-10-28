import { Type, type Static } from "@sinclair/typebox";
import type { ThinkingLevel } from "./agent-spec.ts";
import type { ExitCode } from "./result.ts";

export const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

export const FAIL_ON_VALUES = ["none", "low", "medium", "high", "critical"] as const;
export type FailOn = (typeof FAIL_ON_VALUES)[number];

export const CATEGORIES = [
  "correctness",
  "security",
  "compatibility",
  "error-handling",
  "performance",
  "maintainability",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const VERDICTS = [
  "approve",
  "comment",
  "request_changes",
  "skipped",
  "error",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export const PR_KINDS = [
  "feature",
  "bugfix",
  "refactor",
  "docs",
  "deps",
  "chore",
] as const;
export type PrKind = (typeof PR_KINDS)[number];

export const FindingSchema = Type.Object({
  file: Type.String({ minLength: 1 }),
  line: Type.Number({ minimum: 0 }),
  severity: Type.Union([
    Type.Literal("critical"),
    Type.Literal("high"),
    Type.Literal("medium"),
    Type.Literal("low"),
  ]),
  category: Type.Union([
    Type.Literal("correctness"),
    Type.Literal("security"),
    Type.Literal("compatibility"),
    Type.Literal("error-handling"),
    Type.Literal("performance"),
    Type.Literal("maintainability"),
    Type.Literal("other"),
  ]),
  title: Type.String({ minLength: 1 }),
  detail: Type.String(),
  suggestion: Type.String(),
});

export type Finding = Static<typeof FindingSchema>;

export const SubmitReviewInputSchema = Type.Object({
  summary: Type.String({ minLength: 1 }),
  verdict: Type.Union([
    Type.Literal("approve"),
    Type.Literal("comment"),
    Type.Literal("request_changes"),
  ]),
  findings: Type.Array(FindingSchema),
  files_reviewed: Type.Optional(Type.Number({ minimum: 0 })),
  notes: Type.Optional(Type.String()),
});

export type SubmitReviewInput = Static<typeof SubmitReviewInputSchema>;

export interface DiffFileEntry {
  path: string;
  oldPath: string | null;
  status: string;
  added: number;
  deleted: number;
  lines: number;
  patch: string | null;
  bytes: number;
  patchLines: number;
  oversized: boolean;
  pages?: number;
  note?: string;
  readVia?: string;
  chunk?: number;
}

export interface SkippedFileEntry {
  path: string;
  reason: string;
  added?: number;
  deleted?: number;
}

export interface SkippedFiles {
  excluded: SkippedFileEntry[];
  binary: SkippedFileEntry[];
  empty: SkippedFileEntry[];
}

export interface BaseSnapshotInfo {
  dir: string;
  files: number;
  bytes: number;
  truncated: boolean;
}

export interface DiffInventory {
  baseSha: string;
  baseInput: string;
  headSha: string;
  headInput: string;
  mergeBase: string;
  contextLines: number;
  filesChangedTotal: number;
  files: DiffFileEntry[];
  skipped: SkippedFiles;
  baseSnapshot: BaseSnapshotInfo | null;
  excludes: {
    defaultsApplied: boolean;
    defaultPatterns: string[];
    userPatterns: string[];
    includePatterns: string[];
  };
}

export interface ReviewBudget {
  maxChunks: number;
  maxChunkLines: number;
  maxChunkBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  maxSnapshotBytes: number;
  contextLines: number;
}

export interface ChunkSpec {
  index: number;
  files: string[];
  lines: number;
  bytes: number;
}

export interface ChunkPlan {
  totalChunks: number;
  plannedChunks: number;
  truncatedByBudget: boolean;
  allChunks: ChunkSpec[];
  chunks: ChunkSpec[];
  filesIncluded: DiffFileEntry[];
  unreviewedFiles: string[];
}

export interface ChunkReport {
  chunkIndex: number;
  summary: string;
  verdict: "approve" | "comment" | "request_changes";
  findings: Finding[];
  filesReviewed: number;
  notes?: string;
}

export interface ReviewCoverage {
  planned: number;
  total: number;
  chunks_reviewed: number[];
  chunks_planned: number;
  chunks_total: number;
  files_reviewed: number;
  files_total: number;
  notes?: string;
}

export interface ReviewReport {
  summary: string;
  verdict: Verdict;
  coverage: ReviewCoverage;
  findings: Finding[];
  policyNotes?: string[];
}

export interface GateDecision {
  exitCode: ExitCode;
  passed: boolean;
  verdict: Verdict;
  hitSeverities: Severity[];
  reason: string;
}

export interface PolicyInput {
  issueTypes: string[];
  prKind: PrKind | "unknown";
  inventory: DiffInventory;
  configuredThinking?: ThinkingLevel;
}

export interface ReviewPlan {
  focus: string[];
  thinking?: ThinkingLevel;
  notes: string[];
}
