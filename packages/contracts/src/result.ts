export enum ExitCode {
  Ok = 0,
  GateFailed = 10,
  InvalidReport = 20,
  Infrastructure = 30,
}

export type RunStatus =
  | "ok"
  | "gate_failed"
  | "invalid_report"
  | "infrastructure_error"
  | "skipped"
  | "degraded";

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costTotal: number;
}

export interface RunTimings {
  resolveBaseMs?: number;
  diffMs?: number;
  policyMs?: number;
  agentMs?: number[];
  publishMs?: number;
  totalMs: number;
}

export interface ReviewCoverageSummary {
  planned: number;
  total: number;
  chunksReviewed: number[];
  chunksPlanned: number;
  chunksTotal: number;
  filesReviewed: number;
  filesTotal: number;
}

export interface RunResult<TDetails = unknown> {
  schemaVersion: 2;
  status: RunStatus;
  exitCode: ExitCode;
  verdict: string;
  coverage?: ReviewCoverageSummary;
  findings?: unknown[];
  timings: RunTimings;
  agentUsage?: AgentUsage;
  details?: TDetails;
  error?: string;
}
