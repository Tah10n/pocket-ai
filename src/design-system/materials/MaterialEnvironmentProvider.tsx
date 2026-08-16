import React, { createContext, useContext } from 'react';
import type { MaterialEnvironment } from './contract';
import { FAIL_CLOSED_MATERIAL_ENVIRONMENT } from './environment';

const MaterialEnvironmentContext = createContext<MaterialEnvironment>(
  FAIL_CLOSED_MATERIAL_ENVIRONMENT,
);

export function MaterialEnvironmentProvider({
  children,
  environment,
}: {
  readonly children: React.ReactNode;
  readonly environment: MaterialEnvironment;
}) {
  return (
    <MaterialEnvironmentContext.Provider value={environment}>
      {children}
    </MaterialEnvironmentContext.Provider>
  );
}

export function useMaterialEnvironment(): MaterialEnvironment {
  return useContext(MaterialEnvironmentContext);
}
