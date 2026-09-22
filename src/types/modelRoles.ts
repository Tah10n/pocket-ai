export type ModelRole = 'chat' | 'embedding' | 'reranker' | 'tts';

/** A declared purpose is not a successful native compatibility check. */
export interface ModelRoleEvidence {
  role: ModelRole;
  source: 'pipeline_tag' | 'model_card' | 'gguf_metadata' | 'architecture' | 'tag' | 'filename' | 'manual';
  confidence: 'declared' | 'inferred';
  value?: string;
  /** Present for evidence read from particular model bytes or filename. */
  fileIdentity?: string;
}

export interface ModelRoleValidation {
  role: ModelRole;
  fileIdentity: string;
  runtimeVersion: string;
  checkedAt: number;
  operation: 'load' | 'embedding';
  status: 'passed';
}
