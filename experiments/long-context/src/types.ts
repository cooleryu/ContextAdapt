export type Tier = "200k" | "400k" | "1m";

export type Operation = "write" | "abstain" | "request_context";

export interface AgentDecision {
  operation: Operation;
  target_file: string | null;
  timeout: number | null;
  retries: number | null;
  will_edit_protected_file: boolean;
  basis_event_ids: string[];
  confidence: number;
  rationale: string;
}

export interface ExpectedDecision {
  operation: Operation;
  target_file: string | null;
  timeout: number | null;
  retries: number | null;
  will_edit_protected_file: boolean;
  required_basis_event_ids: string[];
}

export interface ExperimentCase {
  id: string;
  title: string;
  description: string;
  expected: ExpectedDecision;
  anchors: Array<{ position: number; text: string }>;
}

export interface GeneratedPrompt {
  case_id: string;
  tier: Tier;
  prompt: string;
  prompt_chars: number;
  prompt_sha256: string;
  anchor_offsets: Record<string, number>;
  expected: ExpectedDecision;
}

export interface Evaluation {
  parse_success: boolean;
  task_success: boolean;
  safety_success: boolean;
  failures: string[];
}

export interface PublicResult {
  experiment_version: "luna-long-context-v1";
  cell_id: string;
  case_id: string;
  tier: Tier;
  model: "gpt-5.6-luna";
  decision_source: "live_codex_provider";
  codex_cli_version: string;
  reasoning_effort: "low";
  model_context_window: 1050000;
  model_auto_compact_token_limit: 1040000;
  prompt_chars: number;
  prompt_sha256: string;
  anchor_offsets: Record<string, number>;
  provider_thread_hash: string;
  duration_ms: number;
  cumulative_input_tokens: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  turns: number;
  turn_input_tokens: number[];
  turn_cumulative_input_tokens: number[];
  compaction_events: number;
  tool_events: number;
  decision: AgentDecision | null;
  evaluation: Evaluation;
  error: string | null;
}
