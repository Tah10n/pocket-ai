import { StatusBar } from 'expo-status-bar';
import { Platform } from 'react-native';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';

export default function ModalScreen() {
  return (
    <Box className="flex-1 items-center justify-center bg-background-0 dark:bg-background-950 p-5">
      <Text className="text-xl font-bold text-typography-900 dark:text-typography-100">Modal</Text>
      <Box className="my-7 h-px w-4/5 bg-outline-200 dark:bg-outline-800" />
      
      <Text className="text-base text-center text-typography-700 dark:text-typography-400">
        This is a modal screen for platform-specific interactions and settings.
      </Text>

      {/* Use a light status bar on iOS to account for the black space above the modal */}
      <StatusBar style={Platform.OS === 'ios' ? 'light' : 'auto'} />
    </Box>
  );
}
