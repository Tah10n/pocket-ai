import React from 'react';
import { act, render } from '@testing-library/react-native';

import { usePerformanceNavigationTrace } from '../../src/hooks/usePerformanceNavigationTrace';

const mockMark = jest.fn();
let mockMonitoringEnabled = true;
let mockPathname = '/';

jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
}));

jest.mock('@/services/PerformanceMonitor', () => ({
  performanceMonitor: {
    isEnabled: () => mockMonitoringEnabled,
    mark: (...args: any[]) => mockMark(...args),
  },
}));

describe('usePerformanceNavigationTrace', () => {
  function Harness() {
    usePerformanceNavigationTrace();
    return null;
  }

  beforeEach(() => {
    mockMark.mockClear();
    mockMonitoringEnabled = true;
    mockPathname = '/';
  });

  it('marks route changes with sanitized pathname', async () => {
    mockPathname = '/models/1234567890123456?foo=bar#hash';

    render(<Harness />);

    await act(async () => {});

    expect(mockMark).toHaveBeenCalledWith('nav.routeChange', {
      pathname: '/models/:id',
      redactedSegments: 1,
    });
  });

  it('skips marking when monitoring is disabled', async () => {
    mockMonitoringEnabled = false;
    mockPathname = '/models/123';

    render(<Harness />);

    await act(async () => {});

    expect(mockMark).not.toHaveBeenCalled();
  });

  it('marks again when pathname changes', async () => {
    mockPathname = '/start';
    const result = render(<Harness />);

    await act(async () => {});
    mockMark.mockClear();

    mockPathname = '/thread-123abc456def7890';
    result.rerender(<Harness />);
    await act(async () => {});

    expect(mockMark).toHaveBeenCalledWith('nav.routeChange', {
      pathname: '/:id',
      redactedSegments: 1,
    });
  });
});
