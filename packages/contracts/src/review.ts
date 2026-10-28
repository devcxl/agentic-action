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

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  category: Category;
  title: string;
  detail: string;
  suggestion: string;
}

export interface SubmitReviewInput {
  summary: string;
  verdict: "approve" | "comment" | "request_changes";
  findings: Finding[];
  files_reviewed?: number;
  notes?: string;
}

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
