import { NativeModules, Platform } from 'react-native';

export interface AndroidGpuInfoSnapshot {
  glRenderer?: string;
  glVendor?: string;
  glVersion?: string;
  socModel?: string;
  socManufacturer?: string;
  board?: string;
  hardware?: string;
  device?: string;
  product?: string;
  brand?: string;
  model?: string;
  manufacturer?: string;
}

interface NativeGpuInfoModule {
  getGpuInfo(): Promise<Partial<AndroidGpuInfoSnapshot>>;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveGpuInfoModule(): NativeGpuInfoModule | null {
  if (Platform.OS !== 'android') {
    return null;
  }

  const nativeModulesAny = NativeModules as unknown as Record<string, unknown> | undefined;
  if (!nativeModulesAny || typeof nativeModulesAny !== 'object') {
    return null;
  }

  const nativeModule = nativeModulesAny.GpuInfo as NativeGpuInfoModule | undefined;
  if (!nativeModule || typeof nativeModule.getGpuInfo !== 'function') {
    return null;
  }

  return nativeModule;
}

// undefined = not resolved yet; null = resolved but unavailable.
let cachedSnapshot: AndroidGpuInfoSnapshot | null | undefined = undefined;
let inflightSnapshotPromise: Promise<AndroidGpuInfoSnapshot | null> | null = null;

async function readNativeSnapshot(): Promise<AndroidGpuInfoSnapshot | null> {
  const nativeModule = resolveGpuInfoModule();
  if (!nativeModule) {
    return null;
  }

  try {
    const snapshot = await nativeModule.getGpuInfo();
    const glRenderer = normalizeOptionalString(snapshot.glRenderer);
    const glVendor = normalizeOptionalString(snapshot.glVendor);
    const glVersion = normalizeOptionalString(snapshot.glVersion);
    const socModel = normalizeOptionalString(snapshot.socModel);
    const socManufacturer = normalizeOptionalString(snapshot.socManufacturer);
    const board = normalizeOptionalString(snapshot.board);
    const hardware = normalizeOptionalString(snapshot.hardware);
    const device = normalizeOptionalString(snapshot.device);
    const product = normalizeOptionalString(snapshot.product);
    const brand = normalizeOptionalString(snapshot.brand);
    const model = normalizeOptionalString(snapshot.model);
    const manufacturer = normalizeOptionalString(snapshot.manufacturer);

    const hasAnySignal = Boolean(
      glRenderer
      || glVendor
      || glVersion
      || socModel
      || socManufacturer
      || board
      || hardware
      || device
      || product
      || brand
      || model
      || manufacturer
    );

    return hasAnySignal
      ? {
          glRenderer,
          glVendor,
          glVersion,
          socModel,
          socManufacturer,
          board,
          hardware,
          device,
          product,
          brand,
          model,
          manufacturer,
        }
      : null;
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[GpuInfo] Failed to read Android GPU info', error);
    }
    return null;
  }
}

export async function getAndroidGpuInfo(): Promise<AndroidGpuInfoSnapshot | null> {
  if (cachedSnapshot !== undefined) {
    return cachedSnapshot ?? null;
  }

  if (inflightSnapshotPromise) {
    return inflightSnapshotPromise;
  }

  inflightSnapshotPromise = readNativeSnapshot()
    .then((snapshot) => {
      cachedSnapshot = snapshot;
      inflightSnapshotPromise = null;
      return snapshot;
    })
    .catch((error) => {
      inflightSnapshotPromise = null;
      throw error;
    });

  return inflightSnapshotPromise;
}

export function clearAndroidGpuInfoCache(): void {
  cachedSnapshot = undefined;
  inflightSnapshotPromise = null;
}
