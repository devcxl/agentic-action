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

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevSystemOneResponse {
  model: string;
  answers: Record<string, JevChoiceAnswer>;
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
