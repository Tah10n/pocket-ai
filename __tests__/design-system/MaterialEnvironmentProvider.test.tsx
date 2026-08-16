import React from 'react';
import { render } from '@testing-library/react-native';
import { Text } from 'react-native';
import {
  MaterialEnvironmentProvider,
  useMaterialEnvironment,
} from '../../src/design-system/materials/MaterialEnvironmentProvider';
import { createMaterialEnvironment } from '../../src/design-system/materials/environment';

function EnvironmentProbe() {
  const environment = useMaterialEnvironment();

  return (
    <Text testID="material-environment">
      {`${environment.platform}:${environment.transparencyState}:${environment.liquidGlassApiAvailable}`}
    </Text>
  );
}

describe('MaterialEnvironmentProvider', () => {
  it('fails closed before a runtime provider supplies capabilities', () => {
    const screen = render(<EnvironmentProbe />);

    expect(screen.getByTestId('material-environment').props.children).toBe('web:unknown:false');
  });

  it('injects a deterministic environment without reading global Platform state', () => {
    const environment = createMaterialEnvironment('ios', {
      blurViewAvailable: true,
      liquidGlassApiAvailable: true,
      liquidGlassComponentAvailable: true,
      transparencyState: 'allowed',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <EnvironmentProbe />
      </MaterialEnvironmentProvider>,
    );

    expect(screen.getByTestId('material-environment').props.children).toBe('ios:allowed:true');
  });
});
