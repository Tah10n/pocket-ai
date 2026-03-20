import { View } from 'react-native';
import { cssInterop } from 'nativewind';

// Register with NativeWind so className is processed correctly instead of
// triggering printUpgradeWarning (which crashes on React Navigation proxy props).
export const Box = cssInterop(View, { className: 'style' });

