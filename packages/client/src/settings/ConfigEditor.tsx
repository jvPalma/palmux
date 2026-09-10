// ── Raw config.json editor ────────────────────────────────────────────────────
//
// Monaco in the dock with inline validation, plus its
// error state — which is not an alternative proposal but the state 05A has to
// have. Monaco on top, a status bar underneath, and a Save that is dead while
// the text is invalid.
//
// The status bar is the feature, not decoration. The server reads config.json
// at BOOT and falls back to the defaults on anything it cannot use, so an
// accepted-then-ignored write is indistinguishable from a setting that does not
// work. Two gates: this component's own JSON.parse keeps Save disabled while
// the text cannot even parse, and the PUT re-runs the SERVER's boot parser and
// refuses anything it would drop (see server/src/config-file.ts). A successful
// save says "restart required" plainly — nothing here applies live.
//
// The Raw/Form toggle lives here; Form mode renders NOTHING but the header,
// because the form is the settings view the app already has. The raw body is
// hidden rather than unmounted when the toggle flips, so unsaved edits — and
// the cursor, and the undo stack — survive Raw → Form → Raw.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { Button, Segmented } from '../ui';
import { loadSettings } from './settings';
import './config-editor.css';

export type ConfigEditorMode = 'raw' | 'form';

export interface ConfigEditorProps {
  mode: ConfigEditorMode;
  onMode: (mode: ConfigEditorMode) => void;
}

const MODE_OPTIONS = [
  { value: 'raw' as const, label: 'Raw' },
  { value: 'form' as const, label: 'Form' },
];

// Monaco ships no JSON tokenizer in `basic-languages` (JSON highlighting there
// comes bundled with the language SERVICE and its own worker, which
// monaco-loader.ts deliberately does not wire up). This grammar is the whole
// cost of a coloured config file: five rules, no worker, no second
// import path — the editor still comes from getMonaco().
const LANGUAGE_ID = 'palmux-json';
let languageReady = false;

function ensureJsonLanguage(monaco: typeof Monaco): void {
  if (languageReady) return;
  languageReady = true;
  monaco.languages.register({ id: LANGUAGE_ID });
  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, {
    tokenizer: {
      root: [
        // A key is a string followed by a colon; everything else is a value.
        [/"(?:[^"\\]|\\.)*"\s*(?=:)/, 'type'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/[{}[\],:]/, 'delimiter'],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
  });
}

interface Located {
  line?: number | undefined;
  column?: number | undefined;
}

function lineColOf(text: string, position: number): Located {
  const before = text.slice(0, Math.max(0, Math.min(position, text.length)));
  return { line: before.split('\n').length, column: position - before.lastIndexOf('\n') };
}

/**
 * Where JSON.parse gave up. V8 answers in two shapes and only one carries a
 * number — `… at position 18 (line 3 column 1)`, or `Unexpected token ']',
 * ..."<verbatim source>" is not valid JSON`. The second is the shape a trailing
 * comma produces, i.e. the most common config mistake, so its snippet is
 * located in the source to recover the position.
 *
 * Deliberately a twin of `jsonErrorAt` in server/src/config-file.ts rather than
 * a shared import: the same derivation is needed on both sides of the wire, and
 * the wire package (`@palmux/shared`) is the protocol, not a utility belt.
 */
function jsonErrorAt(message: string, text: string): Located {
  const explicit = /line (\d+) column (\d+)/.exec(message);
  if (explicit) return { line: Number(explicit[1]), column: Number(explicit[2]) };
  const at = /position (\d+)/.exec(message);
  if (at) return lineColOf(text, Number(at[1]));
  const ctx = /^.*?, (?:\.\.\.)?"([\s\S]*)"(?:\.\.\.)? is not valid JSON$/.exec(message);
  const snippet = ctx?.[1];
  if (!snippet) return {};
  const base = text.indexOf(snippet);
  if (base < 0) return {};
  const token = /Unexpected token '(.)'/.exec(message)?.[1];
  const offset = token ? snippet.indexOf(token) : -1;
  return lineColOf(text, base + (offset < 0 ? 0 : offset));
}

type LocalCheck = { ok: true; keys: number } | ({ ok: false; message: string } & Located);

function checkJson(text: string): LocalCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message, ...jsonErrorAt(message, text) };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'config.json must be a JSON object' };
  }
  return { ok: true, keys: Object.keys(parsed).length };
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

export const ConfigEditor = ({ mode, onMode }: ConfigEditorProps) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading');
  // The buffer mirrors the Monaco model so the status bar can react to it. The
  // model is what survives a mode flip (the host is hidden, never unmounted);
  // this copy is what survives anything that does remount it.
  const [text, setText] = useState('');
  const [path, setPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<({ message: string } & Located) | null>(null);
  const [savedNote, setSavedNote] = useState('');
  const textRef = useRef(text);
  textRef.current = text;

  const check = useMemo(() => checkJson(text), [text]);

  useEffect(() => {
    let disposed = false;
    let instance: Monaco.editor.IStandaloneCodeEditor | undefined;

    void (async () => {
      try {
        const [{ getMonaco }, res] = await Promise.all([
          import('../panes/monaco-loader'),
          fetch('/config-file'),
        ]);
        // A missing config.json is a legitimate empty 200 — creating one is part
        // of the job. A non-ok response is not: opening an empty editable buffer
        // over a real file invites a Save that wipes it.
        if (!res.ok) {
          if (!disposed) setLoad('error');
          return;
        }
        const body = asRecord(await res.json());
        const content = typeof body['text'] === 'string' ? body['text'] : '';
        if (disposed || !hostRef.current) return;
        const monaco = getMonaco();
        ensureJsonLanguage(monaco);
        monacoRef.current = monaco;
        const editor = monaco.editor.create(hostRef.current, {
          value: content,
          language: LANGUAGE_ID,
          theme: 'palmux',
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12,
          // Explicit, for the same reason EditorPane sets it: Monaco's default
          // stack resolves to a proportional serif on a host without Menlo or
          // Consolas, and JSON in a proportional font is unreadable.
          fontFamily: loadSettings().fontFamily,
          tabSize: 2,
          padding: { top: 8 },
        });
        instance = editor;
        editorRef.current = editor;
        setText(content);
        setPath(typeof body['path'] === 'string' ? body['path'] : '');
        setLoad('ready');
        editor.getModel()?.onDidChangeContent(() => {
          setText(editor.getValue());
          setSaveError(null);
          setSavedNote('');
        });
      } catch {
        if (!disposed) setLoad('error');
      }
    })();

    return () => {
      disposed = true;
      editorRef.current = null;
      monacoRef.current = null;
      instance?.dispose();
    };
  }, []);

  // The offending line is underlined. A marker is also the only feedback
  // that survives scrolling away from the status bar.
  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    const problem = check.ok ? saveError : check;
    const line = problem?.line ?? 0;
    monaco.editor.setModelMarkers(
      model,
      'palmux-config',
      !problem || line < 1
        ? []
        : [
            {
              severity: monaco.MarkerSeverity.Error,
              message: problem.message,
              startLineNumber: line,
              endLineNumber: line,
              startColumn: problem.column ?? 1,
              endColumn: model.getLineMaxColumn(Math.min(line, model.getLineCount())),
            },
          ],
    );
  }, [check, saveError]);

  // Hidden hosts get no resize events; re-measure on the way back into view.
  useEffect(() => {
    if (mode === 'raw') editorRef.current?.layout();
  }, [mode]);

  const save = useCallback(() => {
    const body = textRef.current;
    setSaving(true);
    setSaveError(null);
    setSavedNote('');
    void fetch('/config-file', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body,
    })
      .then(async (res) => {
        if (res.ok) {
          setSavedNote('Saved · restart palmux to apply');
          return;
        }
        const payload = asRecord(await res.json().catch(() => ({})));
        const message =
          typeof payload['error'] === 'string' ? payload['error'] : `save failed (${res.status})`;
        const line = payload['line'];
        setSaveError({ message, ...(typeof line === 'number' ? { line } : {}) });
      })
      .catch(() => setSaveError({ message: 'save failed — no connection to the server' }))
      .finally(() => setSaving(false));
  }, []);

  const failed = load === 'error';
  const loading = load === 'loading';
  // An empty buffer does not parse, so the check only speaks once the file has
  // actually arrived — otherwise every mount flashes a JSON error.
  const problem = failed || loading ? null : check.ok ? saveError : check;
  const errored = failed || problem !== null;

  let status: string;
  if (failed) status = 'could not read config.json';
  else if (loading) status = 'loading…';
  else if (problem) {
    status = problem.line ? `Line ${problem.line} · ${problem.message}` : problem.message;
  } else if (savedNote) status = savedNote;
  else status = `Valid JSON · ${check.ok ? check.keys : 0} keys`;

  return (
    <div className="config-editor" data-testid="config-editor">
      <div className="config-editor-head">
        <span className="config-editor-title" title={path}>
          config.json
        </span>
        <Segmented
          value={mode}
          onValueChange={onMode}
          options={MODE_OPTIONS}
          label="Config editor mode"
          className="config-editor-modes"
          data-testid="config-mode"
        />
      </div>
      <div className="config-editor-body" data-off={mode === 'raw' ? undefined : ''}>
        <div className="config-editor-host" ref={hostRef} data-testid="config-editor-host" />
        <div className="config-editor-status" data-invalid={errored ? '' : undefined}>
          <span className="config-editor-dot" />
          <span className="config-editor-message" data-testid="config-status">
            {status}
          </span>
          <Button
            variant="primary"
            size="sm"
            disabled={errored || saving || load !== 'ready'}
            onClick={save}
            data-testid="config-save"
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
};
