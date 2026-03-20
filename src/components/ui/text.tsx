import { Text as RNText } from 'react-native';
import { cssInterop } from 'nativewind';

// Register with NativeWind so className is processed correctly.
export const Text = cssInterop(RNText, { className: 'style' });

