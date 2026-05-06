import * as v from 'valibot';

// Single source of truth for the triage skill's structured output.
// flue validates the model's response against this; chat.ts renders it.
export const triageSchema = v.object({
  hypothesis: v.string(),
  evidence: v.array(
    v.object({
      source: v.picklist(['datadog', 'github', 'sandbox', 'langfuse', 'other']),
      summary: v.string(),
      link: v.optional(v.string()),
    }),
  ),
  suggested_next_step: v.string(),
  linked_artifacts: v.optional(v.array(v.object({ label: v.string(), url: v.string() })), []),
  confidence: v.picklist(['low', 'medium', 'high']),
});

export type TriageSummary = v.InferOutput<typeof triageSchema>;
