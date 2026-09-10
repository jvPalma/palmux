import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsEditor } from './SettingsEditor';

let editorValue = '{}';
const fakeEditor = {
  getValue: () => editorValue,
  addCommand: vi.fn(),
  dispose: vi.fn(),
};
const fakeMonaco = {
  editor: { create: vi.fn(() => fakeEditor) },
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 },
};
vi.mock('../panes/monaco-loader', () => ({ getMonaco: () => fakeMonaco }));

afterEach(() => vi.clearAllMocks());

describe('SettingsEditor', () => {
  it('applies valid JSON on Save and closes', async () => {
    editorValue = '{ "fontSize": 20 }';
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<SettingsEditor onApply={onApply} onClose={onClose} />);
    await waitFor(() => expect(fakeMonaco.editor.create).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('settings-editor-save'));
    expect(onApply).toHaveBeenCalledWith({ fontSize: 20 });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows an error and does not apply invalid JSON', async () => {
    editorValue = '{ not json';
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<SettingsEditor onApply={onApply} onClose={onClose} />);
    await waitFor(() => expect(fakeMonaco.editor.create).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('settings-editor-save'));
    expect(screen.getByTestId('settings-editor-error')).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('rejects a non-object (array)', async () => {
    editorValue = '[1,2,3]';
    const onApply = vi.fn();
    render(<SettingsEditor onApply={onApply} onClose={() => {}} />);
    await waitFor(() => expect(fakeMonaco.editor.create).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('settings-editor-save'));
    expect(screen.getByTestId('settings-editor-error').textContent).toContain('object');
    expect(onApply).not.toHaveBeenCalled();
  });
});
