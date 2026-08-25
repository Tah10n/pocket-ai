import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { AndroidBlurTargetRef } from '../../utils/androidBlur';

export type AndroidBlurBoundaryId = symbol;

export interface AndroidBlurSampleTarget {
  readonly ownerId: AndroidBlurBoundaryId;
  readonly ready: boolean;
  readonly targetRef: AndroidBlurTargetRef;
}

export interface AndroidBlurBoundary {
  readonly id: AndroidBlurBoundaryId;
  readonly targetRef: AndroidBlurTargetRef;
}

const AndroidBlurSampleTargetContext = createContext<AndroidBlurSampleTarget | null>(null);
const AndroidBlurAncestorBoundariesContext = createContext<readonly AndroidBlurBoundary[]>([]);
const EXTERNAL_ANDROID_BLUR_TARGET_OWNER = Symbol('external-android-blur-target');

interface AndroidBlurTargetReadinessEntry {
  readonly listeners: Set<() => void>;
  ready: boolean;
}

const androidBlurTargetReadiness = new WeakMap<AndroidBlurTargetRef, AndroidBlurTargetReadinessEntry>();

function getReadinessEntry(targetRef: AndroidBlurTargetRef): AndroidBlurTargetReadinessEntry {
  const existingEntry = androidBlurTargetReadiness.get(targetRef);
  if (existingEntry) {
    return existingEntry;
  }

  const entry: AndroidBlurTargetReadinessEntry = {
    listeners: new Set(),
    ready: Boolean(targetRef.current),
  };
  androidBlurTargetReadiness.set(targetRef, entry);
  return entry;
}

function setAndroidBlurTargetReady(targetRef: AndroidBlurTargetRef, ready: boolean) {
  const entry = getReadinessEntry(targetRef);
  if (entry.ready === ready) {
    return;
  }

  entry.ready = ready;
  entry.listeners.forEach((listener) => listener());
}

function useAndroidBlurTargetReadiness(targetRef: AndroidBlurTargetRef | null | undefined) {
  const subscribe = useCallback((listener: () => void) => {
    if (!targetRef) {
      return () => {};
    }

    const entry = getReadinessEntry(targetRef);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }, [targetRef]);
  const getSnapshot = useCallback(
    () => (targetRef ? getReadinessEntry(targetRef).ready : false),
    [targetRef],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useAndroidBlurTargetHandle(
  targetRef: AndroidBlurTargetRef,
  label: string,
  active: boolean,
) {
  const ownerId = useRef(Symbol(label)).current;
  const ready = useAndroidBlurTargetReadiness(targetRef);
  const markReady = useCallback(() => {
    if (active) {
      setAndroidBlurTargetReady(targetRef, true);
    }
  }, [active, targetRef]);
  useEffect(() => {
    if (!active) {
      setAndroidBlurTargetReady(targetRef, false);
    }
  }, [active, targetRef]);
  useEffect(() => () => {
    setAndroidBlurTargetReady(targetRef, false);
  }, [targetRef]);
  const sample = useMemo<AndroidBlurSampleTarget>(() => ({
    ownerId,
    ready: active && ready,
    targetRef,
  }), [active, ownerId, ready, targetRef]);
  const boundary = useMemo<AndroidBlurBoundary>(() => ({
    id: ownerId,
    targetRef,
  }), [ownerId, targetRef]);

  return { boundary, markReady, sample };
}

export function AndroidBlurSampleTargetProvider({
  children,
  target,
}: {
  readonly children: React.ReactNode;
  readonly target: AndroidBlurSampleTarget | null;
}) {
  return (
    <AndroidBlurSampleTargetContext.Provider value={target}>
      {children}
    </AndroidBlurSampleTargetContext.Provider>
  );
}

export function AndroidBlurBoundaryProvider({
  boundary,
  children,
}: {
  readonly boundary: AndroidBlurBoundary | null;
  readonly children: React.ReactNode;
}) {
  const ancestors = useContext(AndroidBlurAncestorBoundariesContext);
  const nextAncestors = useMemo(
    () => (boundary ? [...ancestors, boundary] : ancestors),
    [ancestors, boundary],
  );

  return (
    <AndroidBlurAncestorBoundariesContext.Provider value={nextAncestors}>
      {children}
    </AndroidBlurAncestorBoundariesContext.Provider>
  );
}

export function isAndroidBlurTargetOwnedByAncestor(
  target: AndroidBlurSampleTarget,
  ancestors: readonly AndroidBlurBoundary[],
): boolean {
  return ancestors.some((ancestor) => (
    ancestor.id === target.ownerId
    || ancestor.targetRef === target.targetRef
  ));
}

export function useResolvedAndroidBlurTarget(
  explicitTarget: AndroidBlurTargetRef | null | undefined = undefined,
): AndroidBlurTargetRef | null {
  const sampleTarget = useContext(AndroidBlurSampleTargetContext);
  const ancestors = useContext(AndroidBlurAncestorBoundariesContext);
  const explicitTargetReady = useAndroidBlurTargetReadiness(explicitTarget);
  const candidate = explicitTarget === undefined
    ? sampleTarget
    : explicitTarget
      ? {
        ownerId: sampleTarget?.targetRef === explicitTarget
          ? sampleTarget.ownerId
          : EXTERNAL_ANDROID_BLUR_TARGET_OWNER,
        ready: sampleTarget?.targetRef === explicitTarget
          ? sampleTarget.ready
          : explicitTargetReady,
        targetRef: explicitTarget,
      }
      : null;

  if (
    !candidate
    || !candidate.ready
    || isAndroidBlurTargetOwnedByAncestor(candidate, ancestors)
  ) {
    return null;
  }

  return candidate.targetRef;
}
