import React, { type RefObject } from 'react';
import type { View } from 'react-native';

export type AndroidBlurTargetRef = RefObject<View | null>;

interface AndroidBlurTargetRegistration {
  target: AndroidBlurTargetRef | null;
}

let activeAndroidBlurTarget: AndroidBlurTargetRef | null = null;
const activeAndroidBlurTargetStack: AndroidBlurTargetRegistration[] = [];
const activeAndroidBlurTargetListeners = new Set<() => void>();

function emitActiveAndroidBlurTargetChange() {
  activeAndroidBlurTargetListeners.forEach((listener) => listener());
}

function syncActiveAndroidBlurTarget() {
  const nextRegistration = activeAndroidBlurTargetStack[activeAndroidBlurTargetStack.length - 1];
  const nextTarget = nextRegistration?.target ?? null;

  if (activeAndroidBlurTarget === nextTarget) {
    return;
  }

  activeAndroidBlurTarget = nextTarget;
  emitActiveAndroidBlurTargetChange();
}

function subscribeActiveAndroidBlurTarget(listener: () => void) {
  activeAndroidBlurTargetListeners.add(listener);

  return () => {
    activeAndroidBlurTargetListeners.delete(listener);
  };
}

function getActiveAndroidBlurTargetSnapshot() {
  return activeAndroidBlurTarget;
}

export function setActiveAndroidBlurTarget(target: AndroidBlurTargetRef | null) {
  const registration: AndroidBlurTargetRegistration = { target };
  activeAndroidBlurTargetStack.push(registration);
  syncActiveAndroidBlurTarget();

  return () => {
    const registrationIndex = activeAndroidBlurTargetStack.indexOf(registration);

    if (registrationIndex !== -1) {
      activeAndroidBlurTargetStack.splice(registrationIndex, 1);
      syncActiveAndroidBlurTarget();
    }
  };
}

export function useActiveAndroidBlurTarget() {
  return React.useSyncExternalStore(
    subscribeActiveAndroidBlurTarget,
    getActiveAndroidBlurTargetSnapshot,
    getActiveAndroidBlurTargetSnapshot,
  );
}
