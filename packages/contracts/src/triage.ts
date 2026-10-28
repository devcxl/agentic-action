import { Type, type Static } from "@sinclair/typebox";

export interface TriageTypeSpec {
  label: string;
  description: string;
  color?: string;
}

export interface TriageConfig {
  model: string;
  confidence_floor: number;
  fallback: string;
  max_body_chars: number;
  allow_floating_model?: boolean;
  types: Record<string, TriageTypeSpec>;
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface JevSystemOneRequest {
  model: string;
  state: unknown;
  questions: Record<string, JevChoiceQuestion>;
}

export const JevChoiceAnswerSchema = Type.Object({
  type: Type.Literal("choice"),
  choice: Type.String({ minLength: 1 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  probabilities: Type.Record(Type.String(), Type.Number({ minimum: 0, maximum: 1 })),
});

export type JevChoiceAnswer = Static<typeof JevChoiceAnswerSchema>;

export const JevSystemOneResponseSchema = Type.Object({
  model: Type.String({ minLength: 1 }),
  answers: Type.Record(Type.String(), JevChoiceAnswerSchema),
  usage: Type.Optional(
    Type.Object({
      input_tokens: Type.Number({ minimum: 0 }),
      output_tokens: Type.Number({ minimum: 0 }),
    }),
  ),
});

export type JevSystemOneResponse = Static<typeof JevSystemOneResponseSchema>;

export interface Classification {
  model: string;
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export type TriageDecision =
  | {
      kind: "accepted";
      type: string;
      label: string;
      confidence: number;
      probabilities: Record<string, number>;
      model: string;
    }
  | {
      kind: "degraded";
      label: string;
      reason: "fallback_selected" | "low_confidence";
      top: string;
      confidence: number;
      probabilities: Record<string, number>;
      model: string;
    }
  | {
      kind: "invalid";
      reason: string;
    };
