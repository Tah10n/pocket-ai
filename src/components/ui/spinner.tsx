import { ActivityIndicator } from 'react-native';
import { cssInterop } from 'nativewind';

// Register with NativeWind so className is processed correctly.
export const Spinner = cssInterop(ActivityIndicator, { className: 'style' });

