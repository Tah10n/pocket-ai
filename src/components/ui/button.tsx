import React from 'react';
import { Pressable } from './pressable';
import { Text } from './text';
import { PressableProps, TextProps } from 'react-native';


interface ButtonProps extends PressableProps {
  action?: 'primary' | 'secondary' | 'positive' | 'negative' | 'default';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  children?: React.ReactNode;
  className?: string;
}

const actionStyles = {
  primary: 'bg-primary-500 active:bg-primary-600',
  secondary: 'bg-background-200 dark:bg-background-800 active:bg-background-300 dark:active:bg-background-700',
  positive: 'bg-success-500 active:bg-success-600',
  negative: 'bg-error-500 active:bg-error-600',
  default: 'bg-background-100 dark:bg-background-900 active:bg-background-200 dark:active:bg-background-800'
};

const sizeStyles = {
  xs: 'px-2 py-1 rounded',
  sm: 'px-3 py-1.5 rounded-md',
  md: 'px-4 py-2 rounded-lg',
  lg: 'px-6 py-3 rounded-xl'
};

export const Button = ({ 
  action = 'primary', 
  size = 'md', 
  className = '', 
  children, 
  ...props 
}: ButtonProps) => {
  const combinedClass = `${actionStyles[action] || actionStyles.primary} ${sizeStyles[size] || sizeStyles.md} flex-row items-center justify-center ${className}`;
  
  return (
    <Pressable className={combinedClass} {...props}>
      {children}
    </Pressable>
  );
};

interface ButtonTextProps extends TextProps {
  className?: string;
}

export const ButtonText = ({ className = '', children, ...props }: ButtonTextProps) => {
  return (
    <Text className={`text-typography-0 font-bold text-center ${className}`} {...props}>
      {children}
    </Text>
  );
};
