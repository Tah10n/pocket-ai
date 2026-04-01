import { usePathname } from 'expo-router';
import { useEffect } from 'react';

import { performanceMonitor } from '@/services/PerformanceMonitor';

export function usePerformanceNavigationTrace(): void {
  const pathname = usePathname();

  useEffect(() => {
    performanceMonitor.mark('nav.routeChange', { pathname });
  }, [pathname]);
}

