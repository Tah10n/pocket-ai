import { ScrollView as RNScrollView } from 'react-native';
import { cssInterop } from 'nativewind';

// Register with NativeWind so className is processed correctly.
export const ScrollView = cssInterop(RNScrollView, { className: 'style' });

