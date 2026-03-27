import React from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '@/components/ui/box';

interface ScreenHeaderShellProps {
  children: React.ReactNode;
  contentClassName?: string;
  contentStyle?: StyleProp<ViewStyle>;
  maxWidthClassName?: string;
  testID?: string;
}

interface ScreenContentProps {
  children: React.ReactNode;
  className?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

function joinClassNames(...values: (string | undefined)[]) {
  return values.filter(Boolean).join(' ');
}

export function ScreenHeaderShell({
  children,
  contentClassName,
  contentStyle,
  maxWidthClassName = 'max-w-2xl',
  testID,
}: ScreenHeaderShellProps) {
  const insets = useSafeAreaInsets();
  const shellClassName = 'bg-background-0/88 dark:bg-background-950/88';
  const content = (
    <Box
      testID={testID}
      className={joinClassNames('mx-auto w-full', maxWidthClassName, contentClassName)}
      style={contentStyle}
    >
      {children}
    </Box>
  );

  return (
    <Box className="z-10 w-full overflow-hidden border-b border-outline-200 dark:border-outline-800">
      {Platform.OS === 'android' ? (
        <Box className={shellClassName} style={{ paddingTop: insets.top }}>
          {content}
        </Box>
      ) : (
        <BlurView
          intensity={80}
          tint="default"
          className={shellClassName}
          style={{ paddingTop: insets.top }}
        >
          {content}
        </BlurView>
      )}
    </Box>
  );
}

export function ScreenContent({
  children,
  className,
  style,
  testID,
}: ScreenContentProps) {
  return (
    <Box
      testID={testID}
      className={joinClassNames('mx-auto w-full max-w-2xl', className)}
      style={style}
    >
      {children}
    </Box>
  );
}
