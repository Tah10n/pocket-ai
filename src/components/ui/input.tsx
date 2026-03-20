import { View, TextInput } from 'react-native';
import { cssInterop } from 'nativewind';

// Register with NativeWind so className is processed correctly.
export const Input = cssInterop(View, { className: 'style' });
export const InputField = cssInterop(TextInput, { className: 'style' });

