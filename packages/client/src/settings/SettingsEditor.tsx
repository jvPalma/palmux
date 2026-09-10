// ── Settings-as-JSON editor ───────────────────────────────────────────────────
//
// Opens the current client settings as JSON in Monaco (VS Code-style). Saving
// (Ctrl+S / Save) parses + applies through the normal settings path; invalid JSON
// is rejected loudly, never silently written.

import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { loadSettings, type ClientSettings } from './settings';

export interface SettingsEditorProps {
  onApply: (settings: Partial<ClientSettings>) => void;
  onClose: () => void;
}

export function SettingsEditor({ onApply, onClose }: SettingsEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const applyRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let instance: Monaco.editor.IStandaloneCodeEditor | undefined;

    void (async () => {
      const { getMonaco } = await import('../panes/monaco-loader');
      if (disposed || !hostRef.current) return;
      const monaco = getMonaco();
      const editor = monaco.editor.create(hostRef.current, {
        value: JSON.stringify(loadSettings(), null, 2),
        language: 'json',
        theme: 'palmux',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
      });
      instance = editor;
      editorRef.current = editor;

      const save = () => {
        try {
          const parsed: unknown = JSON.parse(editor.getValue());
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            setError('Settings must be a JSON object.');
            return;
          }
          setError(null);
          onApply(parsed as Partial<ClientSettings>);
          onClose();
        } catch (e) {
          setError(`Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}`);
        }
      };
      applyRef.current = save;
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
    })();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      disposed = true;
      window.removeEventListener('keydown', onKey);
      editorRef.current = null;
      instance?.dispose();
    };
  }, [onApply, onClose]);

  return (
    <div className="panel-overlay" onPointerDown={onClose}>
      <div
        className="panel settings-editor"
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Settings JSON"
      >
        <h2>Settings (JSON)</h2>
        <div className="settings-editor-host" ref={hostRef} data-testid="settings-editor-host" />
        {error && (
          <p className="kb-conflict" role="alert" data-testid="settings-editor-error">
            {error}
          </p>
        )}
        <div className="settings-editor-actions">
          <button
            type="button"
            className="icon-btn"
            style={{ width: 'auto', padding: '0 16px' }}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="icon-btn"
            style={{ width: 'auto', padding: '0 16px' }}
            data-testid="settings-editor-save"
            onClick={() => applyRef.current()}
          >
            Save (Ctrl+S)
          </button>
        </div>
      </div>
    </div>
  );
}
