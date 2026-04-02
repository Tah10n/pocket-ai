import { usePathname } from 'expo-router';
import { useEffect } from 'react';

import { performanceMonitor } from '@/services/PerformanceMonitor';

function isLikelyDynamicRouteSegment(segment: string): boolean {
  if (!segment) {
    return false;
  }

  const lower = segment.toLowerCase();

  if (/^\d{2,}$/.test(segment)) {
    return true;
  }

  if (/^[0-9a-f]{16,}$/i.test(segment)) {
    return true;
  }

  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)
  ) {
    return true;
  }

  if (segment.length >= 16 && /[a-z]/i.test(segment) && /\d/.test(segment)) {
    return true;
  }

  if (lower.startsWith('thread-') || lower.startsWith('message-')) {
    return true;
  }

  return false;
}

function sanitizePathname(pathname: string): { pathname: string; redactedSegments: number } {
  const rawPath = pathname.split(/[?#]/)[0] ?? '';
  const parts = rawPath.split('/').filter(Boolean);

  let redactedSegments = 0;
  const sanitized = parts.map((part) => {
    if (!isLikelyDynamicRouteSegment(part)) {
      return part;
    }

    redactedSegments += 1;
    return ':id';
  });

  return {
    pathname: `/${sanitized.join('/')}`,
    redactedSegments,
  };
}

export function usePerformanceNavigationTrace(): void {
  const pathname = usePathname();

  useEffect(() => {
    const sanitized = sanitizePathname(pathname);

    performanceMonitor.mark('nav.routeChange', {
      pathname: sanitized.pathname,
      redactedSegments: sanitized.redactedSegments,
    });
  }, [pathname]);
}
