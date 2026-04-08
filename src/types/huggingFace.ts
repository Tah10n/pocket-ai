import type { ModelAccessState, ModelMetadata } from './models';

export type HuggingFaceModelSummary = {
  id?: string;
  modelId?: string;
  author?: string;
  sha?: string;
  lastModified?: string;
  siblings?: HuggingFaceSibling[];
  config?: HuggingFaceModelConfig;
  gated?: boolean | string;
  private?: boolean;
  downloads?: number;
  likes?: number;
  tags?: string[];
  pipeline_tag?: string;
  cardData?: HuggingFaceModelCardData;
  gguf?: {
    total?: number;
    context_length?: number;
    architecture?: string;
    size_label?: string;
  };
};

export type HuggingFaceModelCardData = {
  model_name?: string;
  model_type?: string;
  base_model?: string | string[];
  license?: string;
  language?: string | string[];
  datasets?: string[];
  model_creator?: string;
  quantized_by?: string;
  context_length?: number | string;
  max_position_embeddings?: number | string;
  n_positions?: number | string;
  max_sequence_length?: number | string;
  seq_length?: number | string;
  sliding_window?: number | string;
  model_max_length?: number | string;
  n_ctx?: number | string;
  n_ctx_train?: number | string;
  num_ctx?: number | string;
};

export type HuggingFaceModelConfig = {
  max_position_embeddings?: number;
  n_positions?: number;
  max_sequence_length?: number;
  seq_length?: number;
  sliding_window?: number;
  context_length?: number;
  model_max_length?: number;
  n_ctx?: number;
  n_ctx_train?: number;
  num_ctx?: number;
  original_max_position_embeddings?: number;
  text_config?: HuggingFaceModelConfig;
  rope_scaling?: {
    original_max_position_embeddings?: number;
    max_position_embeddings?: number;
  };
  model_type?: string;
  architectures?: string[];
};

export type HuggingFaceSibling = {
  rfilename?: string;
  filename?: string;
  size?: number;
  lfs?: {
    size?: number;
    sha256?: string;
  };
};

export type HuggingFaceTreeEntry = {
  path?: string;
  rfilename?: string;
  filename?: string;
  size?: number;
  lfs?: {
    size?: number;
    sha256?: string;
    oid?: string;
  };
};

export type HuggingFaceModelsPage = {
  items: HuggingFaceModelSummary[];
  nextCursor: string | null;
};

export type HuggingFaceTreeStopReason =
  | 'complete'
  | 'target_found'
  | 'preferred_found'
  | 'lookahead'
  | 'max_pages'
  | 'http_error';

export type HuggingFaceTreeResponse = {
  entries: HuggingFaceTreeEntry[];
  status: number;
  isComplete: boolean;
  stopReason: HuggingFaceTreeStopReason;
};

export type ReadmeModelData = {
  description?: string;
  cardData?: Partial<HuggingFaceModelCardData>;
  maxContextTokens?: number;
};

export type ReadmeFrontMatterValue = string | string[];

export type CatalogCacheEntry<Result> = {
  result: Result;
  timestamp: number;
  isBufferedCursor: boolean;
};

export type CatalogBatchResult = {
  models: ModelMetadata[];
  nextCursor: string | null;
};

export type CatalogRequestContext = {
  authToken: string | null;
  hasAuthToken: boolean;
  authVersion: number;
};

export type ResolvedFileProbeCacheEntry = {
  state: ModelAccessState | null;
  timestamp: number;
};

export type ResolveTreeAccessStateOptions = {
  allowAuthorization?: boolean;
};

export type CreateTreeProbeCandidateOptions = {
  allowPublic?: boolean;
};

export const REQUEST_AUTH_POLICY = {
  ANONYMOUS: 'ANONYMOUS',
  OPTIONAL_AUTH: 'OPTIONAL_AUTH',
  REQUIRED_AUTH: 'REQUIRED_AUTH',
} as const;

export type RequestAuthPolicy = typeof REQUEST_AUTH_POLICY[keyof typeof REQUEST_AUTH_POLICY];

