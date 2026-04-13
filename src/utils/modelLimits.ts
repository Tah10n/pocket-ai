// Shared model-related "soft" limits used in heuristics and UI clamps.
// Keep this file dependency-free so it can be imported from both services and utils.

// Used only when GGUF layer metadata is unavailable. Real models clamp `n_gpu_layers` to their layer count.
// Keep this generous so we don't arbitrarily block GPU offload on larger architectures.
export const UNKNOWN_MODEL_GPU_LAYERS_CEILING = 512;

