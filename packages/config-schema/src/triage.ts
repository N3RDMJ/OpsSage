import { z } from 'zod';

export const triageEvidenceSchema = z.object({
  source: z.enum(['datadog', 'github', 'sandbox', 'langfuse', 'other']),
  summary: z.string(),
  link: z.string().url().optional(),
  data: z.unknown().optional(),
});

export const triageArtifactSchema = z.object({
  label: z.string(),
  url: z.string().url(),
});

export const triageSummarySchema = z.object({
  hypothesis: z.string(),
  evidence: z.array(triageEvidenceSchema),
  suggested_next_step: z.string(),
  linked_artifacts: z.array(triageArtifactSchema).default([]),
  confidence: z.enum(['low', 'medium', 'high']).default('low'),
});

export type TriageEvidence = z.infer<typeof triageEvidenceSchema>;
export type TriageArtifact = z.infer<typeof triageArtifactSchema>;
export type TriageSummary = z.infer<typeof triageSummarySchema>;
