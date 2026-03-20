import { Pressable as RNPressable } from 'react-native';
import { cssInterop } from 'nativewind';

// Register with NativeWind so className is processed correctly.
export const Pressable = cssInterop(RNPressable, { className: 'style' });

