import React from 'react';
import { render } from '@testing-library/react-native';
import { MarkdownRenderer } from '../../src/components/ui/MarkdownRenderer';

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');
  return {
    createInteropElement: mockReact.createElement,
  };
});

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(),
}));

jest.mock('@/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    Box: ({ children }: any) => mockReact.createElement(View, null, children),
  };
});

jest.mock('@/components/ui/text', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    Text: ({ children }: any) => mockReact.createElement(Text, null, children),
  };
});

jest.mock('@/components/ui/pressable', () => {
  const mockReact = require('react');
  const { Pressable } = require('react-native');
  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
  };
});

describe('MarkdownRenderer', () => {
  it('renders headings, lists, and bold text', () => {
    const { getByText } = render(
      <MarkdownRenderer content={'# Heading\n\n- item one\n- item two\n\nThis is **bold** text.'} />,
    );

    expect(getByText('Heading')).toBeTruthy();
    expect(getByText('item one')).toBeTruthy();
    expect(getByText('item two')).toBeTruthy();
    expect(getByText('bold')).toBeTruthy();
  });
});
