import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SubmitReviewFindingParam {
  file: string;
  line: number;
  severity: "critical" | "high" | "medium" | "low";
  category:
    | "correctness"
    | "security"
    | "compatibility"
    | "error-handling"
    | "performance"
    | "maintainability"
    | "other";
  title: string;
  detail: string;
  suggestion: string;
}

export interface SubmitReviewToolParams {
  summary: string;
  verdict: "approve" | "comment" | "request_changes";
  findings: SubmitReviewFindingParam[];
  files_reviewed?: number;
  notes?: string;
}

const submitReviewParametersSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "verdict", "findings"],
  properties: {
    summary: {
      type: "string",
      minLength: 1,
      description: "3-6 sentences summarizing the overall review conclusion and primary risks.",
    },
    verdict: {
      type: "string",
      enum: ["approve", "comment", "request_changes"],
      description: "Review verdict for this chunk or PR.",
    },
    findings: {
      type: "array",
      description: "Structured list of code review findings (empty array if none).",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "file",
          "line",
          "severity",
          "category",
          "title",
          "detail",
          "suggestion",
        ],
        properties: {
          file: { type: "string", minLength: 1 },
          line: { type: "number", minimum: 0 },
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
          },
          category: {
            type: "string",
            enum: [
              "correctness",
              "security",
              "compatibility",
              "error-handling",
              "performance",
              "maintainability",
              "other",
            ],
          },
          title: { type: "string", minLength: 1 },
          detail: { type: "string" },
          suggestion: { type: "string" },
        },
      },
    },
    files_reviewed: {
      type: "number",
      minimum: 0,
      description: "Number of files reviewed in this chunk.",
    },
    notes: {
      type: "string",
      description: "Optional notes about unreviewed content or limitations.",
    },
  },
};

export default function submitReviewExtension(pi: ExtensionAPI): void {
  pi.registerTool<SubmitReviewToolParams, SubmitReviewToolParams>({
    name: "submit_review",
    label: "Submit PR Review Report",
    description:
      "Submit the structured PR review report once you have finished inspecting all patches in the current review scope.",
    parameters: submitReviewParametersSchema,
    outputSchema: submitReviewParametersSchema,
    async execute(_toolCallId, params) {
      if (!params || typeof params.summary !== "string" || !Array.isArray(params.findings)) {
        throw new Error("submit_review requires summary, verdict, and findings[]");
      }
      return {
        content: [
          {
            type: "text",
            text: `Review submitted (${params.findings.length} findings, verdict=${params.verdict}).`,
          },
        ],
        details: params,
        structuredContent: params,
        terminate: true,
      };
    },
  });
}
