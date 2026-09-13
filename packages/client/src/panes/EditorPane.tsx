// ── Editor pane ───────────────────────────────────────────────────────────────
//
// A Monaco editor (the actual VS Code editor component: its keybindings,
// multi-cursor, find/replace) over one of TWO sources. Monaco loads lazily on
// first editor-tab activation. The pane stays mounted across tab switches, so
// the buffer, cursor, and undo history survive; content saves on Ctrl+S, on ~2s
// idle, and when the page is hidden.
//
// The default source is the tab's own note file (GET/PUT `/pane-file?tab=`),
// which is registry-validated and carries no path. Passing `filePath` switches
// it to an arbitrary file (GET/PUT `/file?path=`) for the file browser's Edit
// mode — same editor, different endpoint, and the two differ in three details
// worth stating: the note route answers RAW text while `/file` answers JSON
// (its refusals need a message, and a bare body has nowhere to put one), a note
// is always markdown while a file's language comes from its name, and a failed
// save on a file has a reason the host must be able to show.

import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { loadSettings, onSettingsChange } from '../settings/settings';
import { languageOf } from './editor-language';
import { editorLayoutOptions, observeEditorWidth } from './editor-layout';
import { focusEditor, registerEditor, unregisterEditor } from './editor-registry';

const AUTOSAVE_MS = 2000;
// The editor tracks the terminal font size, a touch larger for readability.
const EDITOR_FONT_OFFSET = 1;
const editorFontSize = (): number => loadSettings().fontSize + EDITOR_FONT_OFFSET;

/**
 * The terminal's own family, and it must be set explicitly. Monaco's default
 * stack is `Menlo, Monaco, 'Courier New', monospace`, and on a Linux host with
 * none of those installed it lands on the generic fallback — which rendered as a
 * PROPORTIONAL SERIF with the per-character advances Monaco had measured for a
 * monospace, so digits and code came out visibly letter-spaced. Palmux already
 * ships JetBrains Mono NF at /webfonts/ and that string is what the setting
 * holds, so the editor and the terminal read as one program.
 */
const editorFontFamily = (): string => loadSettings().fontFamily;

/** The server's own message for a failed request, or a status the user can quote. */
const errorOf = async (res: Response): Promise<string> => {
  try {
    const body = (await res.json()) as { error?: string } | null;
    if (body?.error) return body.error;
  } catch {
    /* not JSON, or an empty body: the status is all there is to report */
  }
  return `HTTP ${res.status}`;
};

interface EditorPaneProps {
  tabId: string;
  active: boolean;
  onDirtyChange: (id: string, dirty: boolean) => void;
  onMenu?: (() => void) | undefined;
  /** Edit this absolute path instead of the tab's note. */
  filePath?: string | undefined;
  /**
   * Save outcome, for a host that draws its own state and would otherwise
   * report "saved" over a write the server refused. `null` clears it.
   */
  onSaveError?: ((message: string | null) => void) | undefined;
}

export const EditorPane = ({
  tabId,
  active,
  onDirtyChange,
  onMenu,
  filePath,
  onSaveError,
}: EditorPaneProps) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [failure, setFailure] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const saveRef = useRef<() => void>(() => {});
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const onDirtyRef = useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;
  const onSaveErrorRef = useRef(onSaveError);
  onSaveErrorRef.current = onSaveError;

  const src = filePath
    ? `/file?path=${encodeURIComponent(filePath)}`
    : `/pane-file?tab=${encodeURIComponent(tabId)}`;
  // The registry key. `src` and not `tabId`: one tab can hold a note OR a file,
  // and the effect below re-creates the editor when it changes.
  const regId = src;

  useEffect(() => {
    let disposed = false;
    let stopWidthWatch: (() => void) | null = null;
    let instance: Monaco.editor.IStandaloneCodeEditor | undefined;
    let autosave: ReturnType<typeof setTimeout> | undefined;
    // A new source starts from scratch: the previous file's error must not
    // caption this one, and a previously-loaded editor is about to be replaced.
    // The HOST is told too — it keeps its own copy of both, so without this a
    // file opened after an edited one reads "unsaved" before it even loads.
    setState('loading');
    setFailure(null);
    setDirty(false);
    onDirtyRef.current(tabId, false);
    onSaveErrorRef.current?.(null);

    void (async () => {
      try {
        const [{ getMonaco }, res] = await Promise.all([import('./monaco-loader'), fetch(src)]);
        // A never-written note is an empty 200. A NON-ok response (auth expiry,
        // 5xx, server restart mid-load, or a file that is too big / unreadable)
        // must NOT open an empty editable buffer — the first edit would autosave
        // and destroy what is on disk. Fail loud, and say why.
        if (!res.ok) {
          const message = await errorOf(res);
          if (!disposed) {
            setFailure(message);
            setState('error');
          }
          return;
        }
        // `/file` answers JSON so its refusals can carry a message; the note
        // route answers the note itself.
        const content = filePath ? ((await res.json()) as { text: string }).text : await res.text();
        if (disposed || !hostRef.current) return;
        const monaco = getMonaco();
        const editor = monaco.editor.create(hostRef.current, {
          value: content,
          language: filePath ? languageOf(filePath) : 'markdown',
          theme: 'palmux',
          automaticLayout: true, // handles pane show/hide + window resizes
          minimap: { enabled: false },
          fontSize: editorFontSize(),
          fontFamily: editorFontFamily(),
          padding: { top: 8 },
          // Gutter chrome is affordable on a desktop pane and not on a 390px
          // phone or a 300px dock — see editor-layout.ts for the measurement.
          ...editorLayoutOptions(hostRef.current.getBoundingClientRect().width),
        });
        instance = editor;
        editorRef.current = editor;
        // Re-apply when the pane crosses the narrow threshold: a phone rotating,
        // the dock opening beside a split, a window resize. Only the crossing
        // fires, so a drag does not re-lay-out the editor on every frame.
        stopWidthWatch = observeEditorWidth(hostRef.current, (opts) => editor.updateOptions(opts));
        // Reachable by the extra-keys bar, which on a phone is the only source
        // of ESC / arrows / HOME / END / TAB there is.
        registerEditor(regId, {
          run: (handlerId) => editor.trigger('extra-keys', handlerId, null),
          type: (text) => editor.trigger('extra-keys', 'type', { text }),
          focus: () => editor.focus(),
        });
        editor.onDidFocusEditorText(() => focusEditor(regId));
        const model = editor.getModel();
        if (!model) return;
        let savedVersion = model.getAlternativeVersionId();
        let saving = false;
        let saveAgain = false; // an edit arrived mid-flight — re-run after

        const markDirty = () => {
          const isDirty = model.getAlternativeVersionId() !== savedVersion;
          setDirty(isDirty);
          onDirtyRef.current(tabId, isDirty);
        };

        const save = () => {
          if (saving) {
            saveAgain = true; // don't drop this edit; flush after the in-flight PUT
            return;
          }
          const version = model.getAlternativeVersionId();
          if (version === savedVersion) return;
          saving = true;
          saveAgain = false;
          void fetch(src, {
            method: 'PUT',
            headers: { 'content-type': 'text/plain;charset=utf-8' },
            body: model.getValue(),
          })
            .then(async (r) => {
              if (r.ok) {
                savedVersion = version;
                markDirty();
                onSaveErrorRef.current?.(null);
                return;
              }
              // A refused write is the one failure the user cannot infer: the
              // text is still on screen and the buffer stays dirty, which on its
              // own is indistinguishable from "not saved yet".
              onSaveErrorRef.current?.(await errorOf(r));
            })
            .catch(() => {
              /* offline — retried on the next edit or the mid-flight re-run */
            })
            .finally(() => {
              saving = false;
              // Only re-run for edits that arrived DURING this PUT. A failed save
              // leaves dirty set and is retried on the next edit / Ctrl+S / idle
              // tick — re-running on failure here would hot-loop the server.
              if (saveAgain) save();
            });
        };
        saveRef.current = save;

        model.onDidChangeContent(() => {
          markDirty();
          clearTimeout(autosave);
          autosave = setTimeout(save, AUTOSAVE_MS);
        });
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
        setState('ready');
      } catch (e) {
        if (!disposed) {
          setFailure(e instanceof Error ? e.message : String(e));
          setState('error');
        }
      }
    })();

    // Flush unsaved edits when the page is being hidden/closed.
    const onHide = () => {
      if (document.visibilityState === 'hidden') saveRef.current();
    };
    document.addEventListener('visibilitychange', onHide);

    return () => {
      disposed = true;
      clearTimeout(autosave);
      document.removeEventListener('visibilitychange', onHide);
      stopWidthWatch?.();
      unregisterEditor(regId);
      editorRef.current = null;
      instance?.dispose();
    };
  }, [src, regId, filePath, tabId]);

  // Follow the terminal font live (settings pub/sub → updateOptions).
  useEffect(
    () =>
      onSettingsChange(() => {
        editorRef.current?.updateOptions({
          fontSize: editorFontSize(),
          fontFamily: editorFontFamily(),
        });
      }),
    [],
  );

  // Monaco swallows Ctrl+S only while focused; catch it pane-wide so the
  // browser's save dialog never appears while an editor tab is active.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [active]);

  return (
    <div className="pane-frame" data-testid={`editor-pane-${tabId}`}>
      <div className="pane-header">
        {onMenu && (
          <button
            className="pane-btn"
            aria-label="Open drawer"
            onPointerDown={(e) => {
              e.preventDefault();
              onMenu();
            }}
          >
            ☰
          </button>
        )}
        <span className="pane-title">notes</span>
        <span className="spacer" />
        <span className="pane-save-state" data-testid="editor-save-state">
          {state === 'error' ? 'failed to load' : dirty ? '● unsaved' : '✓ saved'}
        </span>
      </div>
      {state === 'loading' && <div className="pane-loading">loading editor…</div>}
      {/* In the BODY, not the header: a host can hide the nested header (FilePane
          draws its own), and a load failure there would leave an empty editor
          box — the exact blank surface that reads as a broken feature. */}
      {state === 'error' && (
        <div className="pane-loading" data-testid="editor-load-error">
          {failure ?? 'failed to load'}
        </div>
      )}
      <div className="pane-editor-host" ref={hostRef} />
    </div>
  );
};
