export const visionModelRepoId = 'test-org/vision-chat-model';
export const textOnlyModelRepoId = 'test-org/text-chat-model';

export const visionModelFileName = 'vision-chat-q4_k_m.gguf';
export const projectorFileName = 'mmproj-vision-chat-f16.gguf';
export const alternateProjectorFileName = 'mmproj-vision-chat-q8_0.gguf';
export const textOnlyModelFileName = 'text-chat-q4_k_m.gguf';

export const visionModelSibling = {
  rfilename: visionModelFileName,
  size: 4_294_967_296,
  lfs: {
    sha256: 'vision-model-sha256',
    size: 4_294_967_296,
  },
} as const;

export const projectorSibling = {
  rfilename: projectorFileName,
  size: 536_870_912,
  lfs: {
    sha256: 'projector-sha256',
    size: 536_870_912,
  },
} as const;

export const alternateProjectorSibling = {
  rfilename: alternateProjectorFileName,
  size: 805_306_368,
  lfs: {
    sha256: 'alternate-projector-sha256',
    size: 805_306_368,
  },
} as const;

export const textOnlyModelSibling = {
  rfilename: textOnlyModelFileName,
  size: 2_147_483_648,
  lfs: {
    sha256: 'text-model-sha256',
    size: 2_147_483_648,
  },
} as const;

export const visionCatalogSiblings = [
  visionModelSibling,
  projectorSibling,
] as const;

export const ambiguousProjectorCatalogSiblings = [
  visionModelSibling,
  projectorSibling,
  alternateProjectorSibling,
] as const;

export const projectorOnlyCatalogSiblings = [
  projectorSibling,
  alternateProjectorSibling,
] as const;

export const mixedCatalogSiblings = [
  visionModelSibling,
  projectorSibling,
  textOnlyModelSibling,
] as const;
