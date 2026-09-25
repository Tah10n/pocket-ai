import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { ChatToolsControl } from '../../src/components/ui/ChatToolsControl';
import { LOCAL_TOOL_NAMES } from '../../src/types/localTools';

jest.mock('react-native-css-interop', () => ({ createInteropElement: jest.requireActual<typeof import('react')>('react').createElement }));

it('requires an explicit toggle, exposes its state and describes the scope', () => {
  const change = jest.fn();
  const view = render(<ChatToolsControl settings={{ enabled: false, allowedTools: [] }} onChange={change} />);
  expect(change).not.toHaveBeenCalled();
  expect(view.getByTestId('chat-tools-toggle').props.accessibilityState.checked).toBe(false);
  fireEvent.press(view.getByTestId('chat-tools-info'));
  expect(view.getByText('chat.tools.description')).toBeTruthy();
  fireEvent.press(view.getByTestId('chat-tools-toggle'));
  expect(change).toHaveBeenCalledWith({ enabled: true, allowedTools: [...LOCAL_TOOL_NAMES], toolChoice: 'auto' });
});
