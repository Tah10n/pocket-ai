import DeviceInfo from 'react-native-device-info';

export interface ModelMetadata {
    id: string;
    name: string;
    parameters: string;
    contextWindow: number;
    sizeBytes: number;
    downloadUrl: string;
    sha256?: string;
}

type HuggingFaceModelSummary = {
    id?: string;
    modelId?: string;
    sha?: string;
    siblings?: HuggingFaceSibling[];
    tags?: string[];
};

type HuggingFaceModelDetails = HuggingFaceModelSummary;

type HuggingFaceSibling = {
    rfilename?: string;
    filename?: string;
    size?: number;
    lfs?: {
        size?: number;
        sha256?: string;
    };
};

type HuggingFaceSort = 'downloads' | 'likes' | 'lastModified';

type FetchHuggingFaceModelsOptions = {
    full?: boolean;
    sort?: HuggingFaceSort;
    direction?: 'asc' | 'desc';
    candidateLimit?: number;
    maxBytes?: number;
};

const HF_BASE_URL = 'https://huggingface.co';
const MIN_GGUF_BYTES = 50 * 1024 * 1024; // Avoid tokenizers / tiny artifacts

function encodePathPreservingSlashes(path: string): string {
    return path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

function normalizeSearchQuery(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) return 'gguf';
    if (/gguf/i.test(trimmed)) return trimmed;
    return `${trimmed} gguf`;
}

function getRepoId(model: HuggingFaceModelSummary): string | null {
    if (typeof model.id === 'string' && model.id.length > 0) return model.id;
    if (typeof model.modelId === 'string' && model.modelId.length > 0) return model.modelId;
    return null;
}

function getSiblingFilename(sibling: HuggingFaceSibling): string | null {
    if (typeof sibling.rfilename === 'string' && sibling.rfilename.length > 0) return sibling.rfilename;
    if (typeof sibling.filename === 'string' && sibling.filename.length > 0) return sibling.filename;
    return null;
}

function getSiblingSizeBytes(sibling: HuggingFaceSibling): number | null {
    if (typeof sibling.size === 'number' && Number.isFinite(sibling.size) && sibling.size > 0) return sibling.size;
    if (typeof sibling.lfs?.size === 'number' && Number.isFinite(sibling.lfs.size) && sibling.lfs.size > 0) return sibling.lfs.size;
    return null;
}

function isLikelyModelGguf(filename: string, sizeBytes: number | null): boolean {
    if (!filename.toLowerCase().endsWith('.gguf')) return false;
    const lowered = filename.toLowerCase();
    if (lowered.includes('tokenizer')) return false;
    if (lowered.includes('vocab')) return false;
    if (lowered.includes('mmproj')) return false;
    if (typeof sizeBytes !== 'number' || sizeBytes < MIN_GGUF_BYTES) return false;
    return true;
}

function extractVariantFromFilename(filename: string): string | null {
    const match =
        filename.match(/(?:^|[._-])(Q\d(?:_K)?_[A-Za-z0-9]+)(?:[._-]|$)/i) ??
        filename.match(/(?:^|[._-])(F16|F32|BF16)(?:[._-]|$)/i);
    return match?.[1]?.toUpperCase() ?? null;
}

function buildHuggingFaceResolveUrl(repoId: string, revision: string, filename: string): string {
    const encodedRepoId = encodePathPreservingSlashes(repoId);
    const encodedRevision = encodePathPreservingSlashes(revision);
    const encodedFilename = encodePathPreservingSlashes(filename);
    return `${HF_BASE_URL}/${encodedRepoId}/resolve/${encodedRevision}/${encodedFilename}`;
}

function pickPreferredGguf(
    siblings: HuggingFaceSibling[],
    maxBytes?: number,
): { filename: string; sizeBytes: number; sha256?: string } | null {
    const candidates = siblings
        .map((sibling) => {
            const filename = getSiblingFilename(sibling);
            const sizeBytes = getSiblingSizeBytes(sibling);
            if (!filename || !isLikelyModelGguf(filename, sizeBytes)) return null;
            return { filename, sizeBytes, sha256: sibling.lfs?.sha256 };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

    if (candidates.length === 0) return null;

    let candidatesToConsider = candidates;

    if (typeof maxBytes === 'number' && maxBytes > 0) {
        const fitting = candidates.filter((c) => typeof c.sizeBytes === 'number' && c.sizeBytes <= maxBytes);
        if (fitting.length > 0) {
            candidatesToConsider = fitting;
        }
    }

    const preferredOrder: RegExp[] = [
        /(?:^|[._-])Q4_K_M(?:[._-]|$)/i,
        /(?:^|[._-])Q4_K_S(?:[._-]|$)/i,
        /(?:^|[._-])Q4_(?:[._-]|$)/i,
        /(?:^|[._-])Q5_K_M(?:[._-]|$)/i,
        /(?:^|[._-])Q5_(?:[._-]|$)/i,
        /(?:^|[._-])Q6_(?:[._-]|$)/i,
        /(?:^|[._-])Q8_(?:[._-]|$)/i,
        /(?:^|[._-])F16(?:[._-]|$)/i,
        /(?:^|[._-])F32(?:[._-]|$)/i,
    ];

    const rank = (filename: string) => {
        for (let i = 0; i < preferredOrder.length; i++) {
            if (preferredOrder[i].test(filename)) return i;
        }
        return preferredOrder.length;
    };

    const picked = candidatesToConsider.slice().sort((a, b) => {
        const rA = rank(a.filename);
        const rB = rank(b.filename);
        if (rA !== rB) return rA - rB;
        const sizeA = typeof a.sizeBytes === 'number' ? a.sizeBytes : Number.MAX_SAFE_INTEGER;
        const sizeB = typeof b.sizeBytes === 'number' ? b.sizeBytes : Number.MAX_SAFE_INTEGER;
        return sizeA - sizeB;
    })[0];

    if (!picked) return null;

    return {
        filename: picked.filename,
        sizeBytes: typeof picked.sizeBytes === 'number' ? picked.sizeBytes : 0,
        sha256: picked.sha256,
    };
}

function buildModelListUrl(query: string, limit: number, options: FetchHuggingFaceModelsOptions): string {
    const encodedQuery = encodeURIComponent(query);
    let url = `${HF_BASE_URL}/api/models?search=${encodedQuery}&limit=${limit}`;

    if (options.full) {
        url += '&full=true';
    }

    if (options.sort) {
        url += `&sort=${encodeURIComponent(options.sort)}`;
    }
    if (options.direction) {
        url += `&direction=${options.direction === 'desc' ? '-1' : '1'}`;
    }

    return url;
}

export class ModelCatalogService {
    private detailsCache: Map<string, HuggingFaceModelDetails> = new Map();

    async getDeviceCapabilities() {
        const totalMemory = await DeviceInfo.getTotalMemory();
        const freeStorage = await DeviceInfo.getFreeDiskStorage();
        return { totalMemory, freeStorage };
    }

    private async fetchModelDetails(repoId: string): Promise<HuggingFaceModelDetails> {
        const cached = this.detailsCache.get(repoId);
        if (cached) return cached;

        const response = await fetch(`${HF_BASE_URL}/api/models/${encodePathPreservingSlashes(repoId)}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch model details (${repoId}): ${response.status} ${response.statusText}`);
        }

        const details = (await response.json()) as HuggingFaceModelDetails;
        this.detailsCache.set(repoId, details);
        return details;
    }

    /**
     * Fetch GGUF-capable models from Hugging Face.
     *
     * Notes:
     * - The Hub search endpoint returns repos; we then pick a real .gguf artifact from `siblings`.
     * - For large files, we prefer Q4_K_M / Q4 variants.
     */
    async fetchHuggingFaceModels(
        query: string = 'gguf',
        limit: number = 20,
        options: FetchHuggingFaceModelsOptions = {},
    ): Promise<ModelMetadata[]> {
        const full = options.full ?? true;
        const candidateLimit = options.candidateLimit ?? Math.min(Math.max(limit * 6, 60), 120);

        let response = await fetch(buildModelListUrl(query, candidateLimit, { ...options, full }));
        if (!response.ok && (options.sort || options.direction)) {
            response = await fetch(buildModelListUrl(query, candidateLimit, { ...options, full, sort: undefined, direction: undefined }));
        }
        if (!response.ok && full) {
            response = await fetch(buildModelListUrl(query, candidateLimit, { ...options, full: false, sort: undefined, direction: undefined }));
        }
        if (!response.ok) {
            throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as unknown;
        if (!Array.isArray(data)) {
            throw new Error('Unexpected Hugging Face response (expected an array)');
        }

        const results: ModelMetadata[] = [];

        for (const item of data) {
            if (results.length >= limit) break;
            if (!item || typeof item !== 'object') continue;

            const summary = item as HuggingFaceModelSummary;
            const repoId = getRepoId(summary);
            if (!repoId) continue;

            const summarySiblings = Array.isArray(summary.siblings) ? (summary.siblings as HuggingFaceSibling[]) : [];
            let picked = pickPreferredGguf(summarySiblings, options.maxBytes);

            let details: HuggingFaceModelDetails | null = null;
            if (!picked) {
                details = await this.fetchModelDetails(repoId).catch(() => null);
                const detailsSiblings = Array.isArray(details?.siblings) ? (details!.siblings as HuggingFaceSibling[]) : [];
                picked = pickPreferredGguf(detailsSiblings, options.maxBytes);
            }

            if (!picked) continue;

            const summarySha = typeof summary.sha === 'string' && summary.sha.length > 0 ? summary.sha : undefined;
            if (!details && !summarySha) {
                details = await this.fetchModelDetails(repoId).catch(() => null);
            }

            const revision =
                (typeof details?.sha === 'string' && details.sha.length > 0 ? details.sha : undefined) ??
                summarySha ??
                'main';

            const variant = extractVariantFromFilename(picked.filename);

            results.push({
                id: repoId,
                name: repoId,
                parameters: variant ?? 'Unknown',
                contextWindow: 4096,
                sizeBytes: picked.sizeBytes,
                downloadUrl: buildHuggingFaceResolveUrl(repoId, revision, picked.filename),
                sha256: picked.sha256,
            });
        }

        if (results.length === 0) {
            console.warn('[ModelCatalogService] No models found for query="' + query + '" (limit=' + limit + ', candidateLimit=' + candidateLimit + ', full=' + full + ')');
        }

        return results;
    }

    async getAvailableModels(query?: string): Promise<ModelMetadata[]> {
        const caps = await this.getDeviceCapabilities();
        const isSearch = typeof query === 'string' && query.trim().length > 0;

        const desiredCount = 20;
        const fetchCount = isSearch ? 25 : 35;

        // Filter models based on hardware constraints
        // Strategy: retain models that fit in RAM with 800MB reserved for OS/App,
        // and fit in free storage with 1GB buffer.
        const maxAllowedRam = caps.totalMemory - (800 * 1024 * 1024);
        const maxAllowedStorage = caps.freeStorage - (1024 * 1024 * 1024);
        const maxBytes = Math.min(maxAllowedStorage, Math.floor(maxAllowedRam / 1.2));

        const fetched = await this.fetchHuggingFaceModels(
            isSearch ? normalizeSearchQuery(query!) : 'gguf',
            fetchCount,
            isSearch
                ? { full: true, candidateLimit: 80, maxBytes: maxBytes > 0 ? maxBytes : undefined }
                : { full: true, sort: 'downloads', direction: 'desc', candidateLimit: 120, maxBytes: maxBytes > 0 ? maxBytes : undefined },
        );

        const compatible = fetched.filter((model) => {
            if (!(model.sizeBytes > 0)) return false;
            const ramRequired = model.sizeBytes * 1.2; // Assume 20% overhead for memory
            return ramRequired <= maxAllowedRam && model.sizeBytes <= maxAllowedStorage;
        });

        if (compatible.length > 0) {
            return compatible.slice(0, desiredCount);
        }

        return fetched.slice(0, desiredCount);
    }
}

export const modelCatalogService = new ModelCatalogService();






