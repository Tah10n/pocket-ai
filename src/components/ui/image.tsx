import { Image as RNImage } from 'react-native';
import { cssInterop } from 'nativewind';

// Register with NativeWind so className is processed correctly.
export const Image = cssInterop(RNImage, { className: 'style' });

