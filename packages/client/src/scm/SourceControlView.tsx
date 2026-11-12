// ── Source Control (the dock / drawer body) ───────────────────────────────────
//
// What changed in the project the user picked, grouped the way VS Code groups it:
// Merge Changes (conflicted), Staged Changes and Changes. This is the VIEW only.
// It lists and it hands a choice to its host (`onOpenFile`); the diff itself is a
// `review` tab in the content area, never something drawn in here.
//
// It starts with NO project. A project is a path the user typed, validated by the
// server (`/scm/repo`) and stored by its canonical work-tree top: nothing is
// inferred from the server's cwd, a terminal or an open file. The list is a synced
// setting (the paths are on the server); which project this device reads is local.
// The host owns both settings, so this component takes them as props and reports a
// change. The one setting it follows itself is `scmTree`, how THIS screen reads a
// group (a tree or a flat list): a display choice the editor pane follows the same
// way, through the settings pub/sub, and written back through `onChange`.
//
// Copy comments puts every comment of the project on the clipboard as one markdown
// document (the review's own exporter, with the outdated ones marked); the host
// shows the result as a toast through `onNotice`.
//
// Rows live in a scroller, so they activate on pointer UP (`pressMove`): a finger
// that arrives to pan must not open a file. A group over LONG_GROUP_ROWS rows is a
// `VirtualList` of its own (it is its own scroll container, with a capped height);
// shorter ones are plain rows, which keeps the common case free of measuring.
//
// Each group is a folder tree by default (`scm-tree.ts`: the model, the order and
// the per-device collapse store) or one flat list. Both are the same rows in the
// same component, in the dock and in the drawer. The limit is on the group's FILES,
// not on the rows a tree shows, so collapsing a folder never swaps the list for
// another kind under the user's focus.
//
// When the server announces batch writes (`batchWrites`), a row also offers its
// actions (`row-actions.ts`): Open file, Stage, Unstage and Discard, as inline icon
// buttons on a desktop and as a context menu (right-click, or a long-press on a
// phone). A `<button>` cannot hold buttons, so a row is a wrapper holding the
// unchanged main button and its actions as siblings. The press that opens the menu
// must not also open the review or run an action, so the wrapper records each press
// and the main button and the inline actions refuse a press that opened the menu or
// was not the primary button.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import { SCM_STATUS_LABEL, type ScmEntry, type ScmGroup } from '@palmux/shared';
import {
  Button,
  Collapsible,
  IconButton,
  Input,
  ScrollArea,
  Select,
  VirtualList,
  useDynamicRowHeight,
  useListRef,
  type RowComponentProps,
} from '../ui';
import { ContextMenu, type ContextMenuItemSpec } from '../ui/ContextMenu';
import { Icon } from '../ui/icons';
import { hasLineBreak, LINE_BREAK_MESSAGE } from '../panes/DashboardBody';
import { normalizePin, rootLabel } from '../panes/explorer-pins';
import { entryIconUrl, iconIndex, loadIconIndex, type IconIndex } from '../panes/file-icons';
import { consumeGesture, pressMove } from '../panes/press';
import { useMobileLayer } from '../review/review-density';
import {
  describeFailure,
  describeNoChange,
  describeWrites,
  undoWrites,
} from '../review/review-writes';
import { commentsStore, useComments } from '../review/use-comments';
import { forgetWrites, recordWrite, type LoggedWrite } from '../review/write-log';
import { loadSettings, onSettingsChange, type ClientSettings } from '../settings/settings';
import {
  commentCount,
  commentsMarkdown,
  confirmClearAll,
  copyPendingText,
} from './copy-comments';
import { addScmProject } from './scm-projects';
import {
  DISCARD_UNDO_MS,
  forgetDiscard,
  readLastDiscard,
  recordDiscard,
  subscribeDiscards,
  type LastDiscard,
} from './discard-log';
import {
  discardConfirmText,
  rowActions,
  type RowAction,
  type RowActionContext,
} from './row-actions';
import {
  discardScmPaths,
  fetchScmRepo,
  restoreScmWrite,
  stageScmPaths,
  unstageScmPaths,
} from './scm-api';
import {
  buildTree,
  flattenTree,
  listRows,
  readCollapsed,
  setFolderCollapsed,
  splitPath,
  type TreeRow,
} from './scm-tree';
import { scmStatusStore, useScmStatus } from './status-store';
import './scm.css';

/** A group longer than this is drawn through `VirtualList` instead of as plain rows. */
export const LONG_GROUP_ROWS = 200;

/** What a row activation hands the host: the review to open, and the file in it. */
export interface ScmOpenTarget {
  /** The review the file belongs to. A conflicted file opens the Changes review. */
  group: ScmGroup;
  path: string;
  oldPath?: string;
}

export type ScmProjectChange = Partial<
  Pick<ClientSettings, 'scmRepos' | 'scmActiveRepo' | 'scmTree'>
>;

export interface SourceControlViewProps {
  /** The synced project list (canonical work-tree tops). */
  repos: string[];
  /** The project this device reads, one of `repos`; '' when there is none. */
  activeRepo: string;
  /** On screen. The store counts only visible subscribers, so a hidden view reads nothing. */
  visible: boolean;
  /** A change to the project list and/or to this device's selection. */
  onChange: (change: ScmProjectChange) => void;
  /** Open one file's diff. `{ preview: false }` keeps it open (the row's double-click). */
  onOpenFile: (target: ScmOpenTarget, opts?: { preview?: boolean }) => void;
  /** Open the continuous review of a group (the group header's Open review button). */
  onOpenReview?: ((group: ScmGroup) => void) | undefined;
  /** Where the view says what happened (Copy comments); a toast in the app. */
  onNotice?: ((message: string) => void) | undefined;
  /** Open a file of the project in an editor (a row's Open file action), by absolute path. */
  onOpenPath?: ((absolutePath: string) => void) | undefined;
  /** A toast that can carry an action (a write's Undo). Plain messages fall back to `onNotice`. */
  onNotify?:
    | ((message: string, action?: { label: string; onClick: () => void }) => void)
    | undefined;
  /** The server announced batch writes: rows offer their actions and menus. */
  batchWrites?: boolean | undefined;
}

type ViewGroup = 'merge' | 'staged' | 'changes';

const GROUPS: readonly { id: ViewGroup; title: string }[] = [
  { id: 'merge', title: 'Merge Changes' },
  { id: 'staged', title: 'Staged Changes' },
  { id: 'changes', title: 'Changes' },
];

const BLANK_PATH_MESSAGE = 'Enter the absolute path of a folder inside a git repository';

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const fileCount = (count: number): string => `${count} ${count === 1 ? 'file' : 'files'}`;

type WriteAction = 'stage' | 'unstage' | 'discard';

/** The same entry, read again: storage hands back a new object on every read. */
const sameDiscard = (a: LastDiscard | null, b: LastDiscard | null): boolean =>
  a === b || (a !== null && b !== null && a.receiptId === b.receiptId && a.at === b.at);

/**
 * The project's last discard while it can still be undone (design D9): read again when
 * any window of this device records or forgets one, and at the moment it expires, so the
 * project bar's button goes away by itself.
 */
function useLastDiscard(top: string, enabled: boolean): LastDiscard | null {
  const [last, setLast] = useState<LastDiscard | null>(null);
  useEffect(() => {
    if (!enabled || top === '') {
      setLast(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      clearTimeout(timer);
      const entry = readLastDiscard(top);
      setLast((prev) => (sameDiscard(prev, entry) ? prev : entry));
      if (entry) timer = setTimeout(read, Math.max(0, entry.at + DISCARD_UNDO_MS - Date.now()));
    };
    read();
    const off = subscribeDiscards(read);
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [top, enabled]);
  return last;
}

/** A project's name in the selector: its folder, or the whole path when two share a folder name. */
function projectLabel(repo: string, repos: readonly string[]): string {
  const name = rootLabel(repo);
  return repos.filter((r) => rootLabel(r) === name).length > 1 ? repo : name;
}

/** The display choice of this screen, followed live (see the header). */
function useScmTree(): boolean {
  const [tree, setTree] = useState(() => loadSettings().scmTree);
  useEffect(() => onSettingsChange((settings) => setTree(settings.scmTree)), []);
  return tree;
}

/** What every row of a group needs besides the row itself. */
interface RowContext {
  group: ViewGroup;
  icons: IconIndex | null;
  /** In the tree a file row leaves its directory out: the folders above it say it. */
  tree: boolean;
  /** The row to move focus onto once it is drawn; null when none is wanted. */
  focusKey: string | null;
  onFocused: () => void;
  onOpen: (group: ViewGroup, entry: ScmEntry, opts?: { preview: false }) => void;
  onToggle: (path: string, collapse: boolean) => void;
  onKey: (e: ReactKeyboardEvent, row: TreeRow) => void;
  /** A row's actions; null when the server has no batch writes, and the row is as before. */
  actionsFor: ((row: TreeRow) => RowAction[]) | null;
  /** The mobile layer: a phone reaches the actions through the menu alone. */
  compact: boolean;
}

/** What the wrapper remembers of the press that is on it, for the main button's guard. */
interface PressGuard {
  /** Wrap a row's pointer action: it refuses a press that opened the menu or was not primary. */
  guard: (action: () => void) => () => void;
  onPointerDownCapture: (e: { pointerId: number; button: number }) => void;
  onKeyDownCapture: () => void;
  onMenuOpen: () => void;
}

/**
 * The two guards that keep a menu's opening press from opening the review (design D3,
 * R8). The record is overwritten only by the next pointerdown, never on pointerup: the
 * wrapper's capture would run before the button's own pointerup and leave the guard
 * nothing to read. A refusal spends the record, and a key press clears it, so Enter
 * after a right-click and Escape still opens the file.
 */
function usePressGuard(): PressGuard {
  const press = useRef<{ pointerId: number; button: number } | null>(null);
  const menuOpened = useRef(false);
  return useMemo<PressGuard>(
    () => ({
      guard: (action) => () => {
        if (menuOpened.current || (press.current !== null && press.current.button !== 0)) {
          menuOpened.current = false;
          press.current = null;
          return;
        }
        action();
      },
      onPointerDownCapture: (e) => {
        press.current = { pointerId: e.pointerId, button: e.button };
        if (e.button === 0) menuOpened.current = false;
      },
      onKeyDownCapture: () => {
        press.current = null;
        menuOpened.current = false;
      },
      onMenuOpen: () => {
        menuOpened.current = true;
        // `onOpen` carries no event, so the press is the one the wrapper recorded. A menu
        // opened from the keyboard has none, and there is no pointer tail to swallow.
        const held = press.current;
        if (held !== null)
          consumeGesture({ pointerId: held.pointerId, type: 'pointerdown' }, () => {});
      },
    }),
    [],
  );
}

/**
 * A row with its actions: the wrapper, the unchanged main button, the inline buttons
 * (not on a phone) and the context menu, all drawn from one `rowActions` list. Without
 * batch writes it is the main button alone, exactly as before.
 */
const RowShell = ({
  row,
  name,
  context,
  press,
  children,
}: {
  row: TreeRow;
  name: string;
  context: RowContext;
  press: PressGuard;
  children: ReactElement;
}) => {
  const actions = context.actionsFor?.(row) ?? null;
  if (actions === null) return children;
  const items: ContextMenuItemSpec[] = actions.map((action) => ({
    id: action.id,
    label: action.label,
    icon: <Icon name={action.icon} size={14} />,
    onSelect: action.run,
    danger: action.danger,
    disabled: action.disabled !== undefined,
    separatorBefore: action.id === 'discard',
  }));
  return (
    <ContextMenu items={items} testidPrefix="scm-menu" onOpen={press.onMenuOpen}>
      <div
        className="scm-item"
        data-testid="scm-item"
        onPointerDownCapture={press.onPointerDownCapture}
        onKeyDownCapture={press.onKeyDownCapture}
      >
        {children}
        {!context.compact && actions.length > 0 && (
          <span className="scm-actions" role="group" aria-label={`Actions for ${name}`}>
            {actions.map((action) => (
              <ActionButton key={action.id} action={action} press={press} />
            ))}
          </span>
        )}
      </div>
    </ContextMenu>
  );
};

const ActionButton = ({ action, press }: { action: RowAction; press: PressGuard }) => {
  const disabled = action.disabled !== undefined;
  return (
    <>
      {action.id === 'discard' && <span className="scm-actions-sep" aria-hidden="true" />}
      <IconButton
        label={action.label}
        size="sm"
        // The reason rides the tooltip: a disabled control says why it is.
        title={action.disabled ?? action.label}
        disabled={disabled}
        data-danger={action.danger ? 'true' : undefined}
        data-testid={`scm-action-${action.id}`}
        // A disabled button still hears pointer events in some engines: give it nothing to run.
        // The row's guard as well: a right-click on the button opens the menu, and its release
        // must not run the action under it.
        {...(disabled ? {} : pressMove(press.guard(action.run)))}
      >
        <Icon name={action.icon} size={14} />
      </IconButton>
    </>
  );
};

/**
 * Focus the row's button when the group asks for it, then say it was done. A row
 * the virtual list has not drawn yet gets its focus when it is: the request waits.
 */
function useFocusRequest(requested: boolean, done: () => void) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!requested) return;
    ref.current?.focus();
    done();
  }, [requested, done]);
  return ref;
}

/** One level of a tree is one step of the scale; the stylesheet multiplies it by the depth. */
const depthStyle = (depth: number): Record<string, string> => ({ '--depth': String(depth) });

/** How many rows the virtual list holds, for the stylesheet's height cap. */
const rowCountStyle = (count: number): Record<string, string> => ({ '--scm-rows': String(count) });

const FileRow = ({
  row,
  context,
}: {
  row: Extract<TreeRow, { kind: 'file' }>;
  context: RowContext;
}) => {
  const { group, icons, tree, focusKey, onFocused, onOpen, onKey } = context;
  const { entry } = row;
  const ref = useFocusRequest(focusKey === row.key, onFocused);
  const press = usePressGuard();
  const icon = entryIconUrl(icons, row.name, false);
  const label = SCM_STATUS_LABEL[entry.status];
  // A rename names where it came from: the old path is part of what the row says,
  // in the tree as well, where the directory is not.
  const origin = entry.oldPath ? `← ${entry.oldPath}` : '';
  const { dir } = splitPath(entry.path);
  const where = tree ? origin : [dir || (origin ? '.' : ''), origin].filter(Boolean).join(' ');
  return (
    <RowShell row={row} name={row.name} context={context} press={press}>
      <button
        ref={ref}
        type="button"
        className="scm-row"
        style={tree ? depthStyle(row.depth) : undefined}
        data-testid={`scm-row-${group}:${entry.path}`}
        data-status={entry.status}
        data-conflicted={group === 'merge' ? 'true' : undefined}
        title={entry.oldPath ? `${entry.path} (renamed from ${entry.oldPath})` : entry.path}
        onKeyDown={tree ? (e) => onKey(e, row) : undefined}
        {...pressMove(press.guard(() => onOpen(group, entry)))}
        // `pressMove` hands its action no event, so a double-click is heard here: the first click
        // already opened the file as a preview, and this pinned open keeps it (D4).
        onDoubleClick={() => onOpen(group, entry, { preview: false })}
      >
        {tree && <span className="scm-twisty" aria-hidden="true" />}
        {icon ? (
          <img className="scm-glyph" src={icon} alt="" aria-hidden="true" loading="lazy" />
        ) : (
          <span className="scm-glyph scm-glyph-fallback" aria-hidden="true">
            <Icon name="file" size={14} />
          </span>
        )}
        <span className="scm-name">{row.name}</span>
        {where && <span className="scm-dir">{where}</span>}
        <span
          className="scm-letter"
          data-status={entry.status}
          role="img"
          aria-label={label}
          title={label}
        >
          {entry.status}
        </span>
      </button>
    </RowShell>
  );
};

const FolderRow = ({
  row,
  context,
}: {
  row: Extract<TreeRow, { kind: 'folder' }>;
  context: RowContext;
}) => {
  const { group, icons, focusKey, onFocused, onToggle, onKey } = context;
  const { node, open } = row;
  const ref = useFocusRequest(focusKey === row.key, onFocused);
  const press = usePressGuard();
  // A chain is named by its deepest folder, as VS Code does for a compact folder.
  const icon = entryIconUrl(icons, node.path.slice(node.path.lastIndexOf('/') + 1), true, open);
  const files = `${node.files} ${node.files === 1 ? 'file' : 'files'}`;
  // A long chain gives way at the front: the folder the row is about is its last one.
  const cut = node.name.lastIndexOf('/') + 1;
  const head = node.name.slice(0, cut);
  const tail = node.name.slice(cut);
  return (
    <RowShell row={row} name={node.name} context={context} press={press}>
      <button
        ref={ref}
        type="button"
        className="scm-folder"
        style={depthStyle(row.depth)}
        data-testid={`scm-folder-${group}:${node.path}`}
        aria-expanded={open}
        aria-label={`${node.name}, ${files}`}
        title={node.path}
        onKeyDown={(e) => onKey(e, row)}
        {...pressMove(press.guard(() => onToggle(node.path, open)))}
      >
        <span className="scm-twisty" aria-hidden="true">
          <Icon name="chevron-right" size={14} />
        </span>
        {icon ? (
          <img className="scm-glyph" src={icon} alt="" aria-hidden="true" loading="lazy" />
        ) : (
          <span className="scm-glyph scm-glyph-fallback" aria-hidden="true">
            <Icon name={open ? 'folder-open' : 'folder'} size={14} />
          </span>
        )}
        <span className="scm-name scm-chain">
          {head && <span className="scm-chain-head">{head}</span>}
          <span className="scm-chain-tail">{tail}</span>
        </span>
        <span
          className="scm-folder-count"
          data-testid={`scm-folder-count-${group}:${node.path}`}
          aria-hidden="true"
        >
          {node.files}
        </span>
      </button>
    </RowShell>
  );
};

const ListRow = ({ row, context }: { row: TreeRow; context: RowContext }) =>
  row.kind === 'folder' ? (
    <FolderRow row={row} context={context} />
  ) : (
    <FileRow row={row} context={context} />
  );

interface VirtualRowProps {
  rows: readonly TreeRow[];
  context: RowContext;
}

// The row component sits at module level so its identity is stable: react-window
// would remount every row if it changed on a render.
const VirtualListRow = ({
  index,
  style,
  ariaAttributes,
  rows,
  context,
}: RowComponentProps<VirtualRowProps>) => {
  const row = rows[index];
  if (!row) return null;
  return (
    <div style={style} {...ariaAttributes}>
      <ListRow row={row} context={context} />
    </div>
  );
};

interface GroupSectionProps {
  id: ViewGroup;
  title: string;
  /** The project: the collapse store is keyed by it, and a switch remounts the group. */
  repo: string;
  entries: ScmEntry[];
  icons: IconIndex | null;
  tree: boolean;
  onOpen: (group: ViewGroup, entry: ScmEntry, opts?: { preview: false }) => void;
  onOpenReview?: ((group: ScmGroup) => void) | undefined;
  /** What the row actions need besides the group's entries; null without batch writes. */
  writes: Omit<RowActionContext, 'entries'> | null;
}

const GroupSection = ({
  id,
  title,
  repo,
  entries,
  icons,
  tree,
  onOpen,
  onOpenReview,
  writes,
}: GroupSectionProps) => {
  // Rows are `--scm-row-h` tall (24px on a desktop and on a phone), so they are measured
  // rather than assumed; the default only sizes the scrollbar until they are.
  const rowHeight = useDynamicRowHeight({ defaultRowHeight: 24 });
  // The header takes the kit's small step on a desktop and its extra-small step on a phone,
  // so it is no taller than the rows it heads (24px either way).
  const compact = useMobileLayer();
  const listRef = useListRef(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(readCollapsed(repo, id)),
  );
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const clearFocus = useCallback(() => setFocusKey(null), []);

  const nodes = useMemo(() => (tree ? buildTree(entries) : []), [tree, entries]);
  const rows = useMemo(
    () => (tree ? flattenTree(nodes, collapsed) : listRows(entries)),
    [tree, nodes, collapsed, entries],
  );

  const toggle = useCallback(
    (path: string, collapse: boolean) => {
      setFolderCollapsed(repo, id, path, collapse);
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (collapse) next.add(path);
        else next.delete(path);
        return next;
      });
    },
    [repo, id],
  );

  const focusRow = useCallback(
    (key: string) => {
      const index = rows.findIndex((row) => row.key === key);
      if (index < 0) return;
      // A long group draws only the rows near the view: bring the target in so it can take focus.
      listRef.current?.scrollToRow({ index, align: 'auto' });
      setFocusKey(key);
    },
    [rows, listRef],
  );

  const onKey = useCallback(
    (e: ReactKeyboardEvent, row: TreeRow) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      // Enter and Space are the button's own click, which toggles or opens.
      if (e.key === 'ArrowRight') {
        if (row.kind !== 'folder' || row.open) return;
        e.preventDefault();
        toggle(row.node.path, false);
      } else if (e.key === 'ArrowLeft') {
        if (row.kind === 'folder' && row.open) {
          e.preventDefault();
          toggle(row.node.path, true);
        } else if (row.parent !== null) {
          e.preventDefault();
          focusRow(`d:${row.parent}`);
        }
      }
    },
    [toggle, focusRow],
  );

  // A folder acts on the group's FULL list, so the entries ride the context whole.
  const actionsFor = useMemo(
    () => (writes ? (row: TreeRow) => rowActions(id, row, { ...writes, entries }) : null),
    [writes, id, entries],
  );

  const context = useMemo<RowContext>(
    () => ({
      group: id,
      icons,
      tree,
      focusKey,
      onFocused: clearFocus,
      onOpen,
      onToggle: toggle,
      onKey,
      actionsFor,
      compact,
    }),
    [id, icons, tree, focusKey, clearFocus, onOpen, toggle, onKey, actionsFor, compact],
  );
  const rowProps = useMemo<VirtualRowProps>(() => ({ rows, context }), [rows, context]);

  return (
    <Collapsible
      title={
        <>
          <span className="scm-group-title">{title}</span>
          <span className="scm-count" data-testid={`scm-count-${id}`}>
            {entries.length}
          </span>
        </>
      }
      storageKey={`palmux-scm-group-${id}`}
      size={compact ? 'xs' : 'sm'}
      actions={
        onOpenReview && (
          <IconButton
            label="Open review"
            size={compact ? 'xs' : 'sm'}
            data-testid={`scm-open-review-${id}`}
            // A conflicted file is reviewed in Changes, so the merge group opens that review.
            {...pressMove(() => onOpenReview(id === 'staged' ? 'staged' : 'changes'))}
          >
            <Icon name="external" size={14} />
          </IconButton>
        )
      }
      data-testid={`scm-group-${id}`}
    >
      {entries.length > LONG_GROUP_ROWS ? (
        <VirtualList
          className="scm-vlist"
          data-testid={`scm-vlist-${id}`}
          // The class sets the height, up to a cap; the row count it needs is the
          // one thing a stylesheet cannot know. The first paint uses defaultHeight.
          style={rowCountStyle(rows.length)}
          defaultHeight={400}
          listRef={listRef}
          rowCount={rows.length}
          rowHeight={rowHeight}
          rowComponent={VirtualListRow}
          rowProps={rowProps}
        />
      ) : (
        <div className="scm-rows">
          {rows.map((row) => (
            <ListRow key={row.key} row={row} context={context} />
          ))}
        </div>
      )}
    </Collapsible>
  );
};

interface AddFormProps {
  checking: boolean;
  note: string | null;
  draft: string;
  onDraft: (value: string) => void;
  onNote: (note: string | null) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

const AddForm = ({ checking, note, draft, onDraft, onNote, onSubmit, onCancel }: AddFormProps) => {
  return (
    <div className="scm-add" data-testid="scm-add-form">
      <div className="scm-add-row">
        <Input
          autoFocus
          value={draft}
          placeholder="/absolute/path/to/project"
          aria-label="Project path"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={checking}
          data-testid="scm-add-input"
          onChange={(e) => {
            onDraft(e.target.value);
            onNote(null);
          }}
          // A text input removes CR/LF from a paste before `onChange` runs, so a path
          // pasted from a terminal with its newline would arrive without it and name
          // a different folder. The raw clipboard text is the last place it shows.
          onPaste={(e) => {
            if (!hasLineBreak(e.clipboardData.getData('text'))) return;
            e.preventDefault();
            onNote(LINE_BREAK_MESSAGE);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit();
            else if (e.key === 'Escape') onCancel();
          }}
        />
        <Button
          variant="primary"
          size="sm"
          disabled={checking}
          data-testid="scm-add-submit"
          {...pressMove(onSubmit)}
        >
          {checking ? 'Checking…' : 'Add'}
        </Button>
        <Button size="sm" data-testid="scm-add-cancel" {...pressMove(onCancel)}>
          Cancel
        </Button>
      </div>
      {note !== null && (
        <div className="scm-note" data-tone="error" role="alert" data-testid="scm-add-note">
          {note}
        </div>
      )}
    </div>
  );
};

export const SourceControlView = ({
  repos,
  activeRepo,
  visible,
  onChange,
  onOpenFile,
  onOpenReview,
  onNotice,
  onOpenPath,
  onNotify,
  batchWrites = false,
}: SourceControlViewProps) => {
  const { status, error } = useScmStatus(activeRepo, visible);
  const { comments } = useComments(activeRepo, visible);
  const tree = useScmTree();
  const [copying, setCopying] = useState(false);
  // A second tap before the first has re-rendered must not start a second copy.
  const copyingRef = useRef(false);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // The Material icon index is fetched, not bundled, and the list never waits on
  // it: rows draw a fallback glyph and swap when it lands (the Explorer's rule).
  const [icons, setIcons] = useState<IconIndex | null>(iconIndex);
  useEffect(() => {
    if (icons) return;
    let live = true;
    void loadIconIndex().then((idx) => {
      if (live && idx) setIcons(idx);
    });
    return () => {
      live = false;
    };
  }, [icons]);

  // The server's answer arrives after the list may have moved on (another window
  // synced a change), so the project is added to the list as it is THEN.
  const latest = useRef({ repos, activeRepo });
  latest.current = { repos, activeRepo };

  const closeForm = useCallback(() => {
    setAdding(false);
    setDraft('');
    setNote(null);
  }, []);

  const submit = useCallback(async () => {
    if (checking) return;
    // The path is sent exactly as typed: `app ` and `app` are two folders, so
    // `trim()` only DETECTS a blank entry. (A line break never reaches here: the
    // field strips it before `onChange`, and `AddForm` refuses it at the paste.)
    if (draft.trim() === '') {
      setNote(BLANK_PATH_MESSAGE);
      return;
    }
    setChecking(true);
    setNote(null);
    const result = await fetchScmRepo(draft);
    setChecking(false);
    if (!result.ok) {
      setNote(result.message);
      return;
    }
    const top = normalizePin(result.value.top);
    if (!top) {
      setNote('The server did not name a work tree');
      return;
    }
    // The same project twice is not a second entry: it only becomes the active one.
    onChange(addScmProject({ scmRepos: latest.current.repos }, top));
    closeForm();
  }, [checking, draft, onChange, closeForm]);

  const removeActive = useCallback(() => {
    const at = repos.indexOf(activeRepo);
    if (at < 0) return;
    const rest = repos.filter((r) => r !== activeRepo);
    // The project that followed it takes over; the last one hands over to the one before.
    onChange({ scmRepos: rest, scmActiveRepo: rest[Math.min(at, rest.length - 1)] ?? '' });
  }, [repos, activeRepo, onChange]);

  const open = useCallback(
    (group: ViewGroup, entry: ScmEntry, opts?: { preview: false }) => {
      const target: ScmOpenTarget = {
        group: group === 'staged' ? 'staged' : 'changes',
        path: entry.path,
        ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      };
      if (opts) onOpenFile(target, opts);
      else onOpenFile(target);
    },
    [onOpenFile],
  );

  // One write in flight per project: a second tap before the first answer must not post
  // again, and the ref sees it before any re-render could.
  const writingRef = useRef(new Set<string>());
  const [writing, setWriting] = useState<ReadonlySet<string>>(() => new Set());
  const setWritingFor = useCallback((top: string, on: boolean) => {
    if (on) writingRef.current.add(top);
    else writingRef.current.delete(top);
    setWriting(new Set(writingRef.current));
  }, []);
  const busy = writing.has(activeRepo);
  const lastDiscard = useLastDiscard(activeRepo, batchWrites);

  /** Say something; with an action only where the host can draw one. */
  const notify = useCallback(
    (message: string, action?: { label: string; onClick: () => void }) => {
      if (onNotify) onNotify(message, action);
      else onNotice?.(message);
    },
    [onNotify, onNotice],
  );

  // One Undo takes back every write the toast named, newest first: the review's rule,
  // since the two share the window's one toast and its write log.
  const undo = useCallback(
    async (writes: readonly LoggedWrite[]) => {
      // `undoWrites` also takes each discard it restores out of the project bar, from any pane.
      const outcome = await undoWrites(restoreScmWrite, writes);
      forgetWrites(writes.slice(writes.length - outcome.undone));
      if (outcome.undone > 0) scmStatusStore.refresh();
      if (outcome.kind === 'notice') {
        onNotice?.(outcome.message);
        return;
      }
      notify(outcome.undone === 1 ? 'Undone' : `Undid ${outcome.undone} files`);
    },
    [notify, onNotice],
  );

  const write = useCallback(
    async (action: WriteAction, entries: ScmEntry[]) => {
      const top = activeRepo;
      const [first] = entries;
      if (top === '' || first === undefined || writingRef.current.has(top)) return;
      if (action === 'discard') {
        // A discard has no trash: the confirm names what goes, and Cancel sends nothing.
        const untracked = entries.filter((entry) => entry.status === '?').length;
        const text = discardConfirmText(
          entries.map((entry) => entry.path),
          untracked,
        );
        if (!window.confirm(text)) return;
      }
      setWritingFor(top, true);
      let result;
      try {
        result =
          action === 'stage'
            ? await stageScmPaths(
                top,
                entries.map((entry) => entry.path),
              )
            : action === 'unstage'
              ? await unstageScmPaths(
                  top,
                  entries.map(({ path, oldPath }) => (oldPath ? { path, oldPath } : { path })),
                )
              : await discardScmPaths(
                  top,
                  entries.map(({ path, fp }) => ({ path, fp })),
                );
      } finally {
        setWritingFor(top, false);
      }
      // Whatever the answer, the files moved or may have: read the list again now.
      scmStatusStore.refresh();
      if (!result.ok) {
        onNotice?.(describeFailure(result, action));
        return;
      }
      const { receiptId, done, skipped } = result.value;
      // Nothing changed, so there is nothing to undo and nothing to log (R1).
      if (receiptId === null) {
        notify(describeNoChange(action, skipped));
        return;
      }
      const at = Date.now();
      if (action === 'discard') recordDiscard(top, { receiptId, at, count: done.length });
      const recent = recordWrite({
        repo: top,
        receiptId,
        action,
        // Named only when the write changed one file; a folder write is told by its count.
        name: baseName(done[0] ?? first.path),
        at,
        count: done.length,
        via: 'list',
        ...(skipped.length > 0 ? { skipped } : {}),
      });
      notify(describeWrites(recent), { label: 'Undo', onClick: () => void undo(recent) });
    },
    [activeRepo, setWritingFor, onNotice, notify, undo],
  );

  const undoLastDiscard = useCallback(async () => {
    const top = activeRepo;
    const entry = lastDiscard;
    if (entry === null || writingRef.current.has(top)) return;
    setWritingFor(top, true);
    let result;
    try {
      result = await restoreScmWrite(top, entry.receiptId);
    } finally {
      setWritingFor(top, false);
    }
    // A refused Undo may still have put some files back (the server says how many).
    scmStatusStore.refresh();
    // A receipt that was used or is gone leaves BOTH places that offer it: the toast's write
    // log holds the same discard for 6 s, and a later toast's Undo would otherwise try it again,
    // be refused and stop before the older writes it names. The log forgets by receipt, so
    // the entry is rebuilt from what the project bar holds.
    const spend = () => {
      forgetDiscard(top, entry.receiptId);
      forgetWrites([
        { repo: top, receiptId: entry.receiptId, action: 'discard', name: '', at: entry.at },
      ]);
    };
    if (result.ok) {
      spend();
      notify(`Restored ${fileCount(entry.count)}`);
    } else if (result.code === 'token' || result.httpStatus === 410) {
      // Expired, used, or lost with a server restart: nothing can bring it back.
      spend();
      onNotice?.('This Undo has expired');
    } else {
      // A conflict keeps the entry: the Undo works again once the files are out of its way.
      onNotice?.(describeFailure(result, 'discard'));
    }
  }, [activeRepo, lastDiscard, setWritingFor, notify, onNotice]);

  const truncated = status?.truncated ?? false;
  const writes = useMemo<Omit<RowActionContext, 'entries'> | null>(
    () =>
      batchWrites && activeRepo !== ''
        ? {
            top: activeRepo,
            truncated,
            busy,
            ...(onOpenPath ? { onOpenPath } : {}),
            onStage: (entries) => void write('stage', entries),
            onUnstage: (entries) => void write('unstage', entries),
            onDiscard: (entries) => void write('discard', entries),
          }
        : null,
    [batchWrites, activeRepo, truncated, busy, onOpenPath, write],
  );

  const copyComments = useCallback(async () => {
    if (copyingRef.current || comments.length === 0) return;
    copyingRef.current = true;
    setCopying(true);
    try {
      // Not awaited here: the clipboard has to be asked inside the tap, so it takes
      // the document while the file reads are still running.
      const copied = await copyPendingText(commentsMarkdown(activeRepo, status, comments));
      const count = commentCount(comments.length);
      onNotice?.(copied ? `Copied ${count}` : 'Could not copy the comments');
    } finally {
      copyingRef.current = false;
      setCopying(false);
    }
  }, [comments, activeRepo, status, onNotice]);

  const clearComments = useCallback(async () => {
    if (!confirmClearAll(comments.length, activeRepo)) return;
    const result = await commentsStore.clearAll();
    if (!result.ok) onNotice?.(`Could not delete the comments: ${result.message}`);
  }, [comments.length, activeRepo, onNotice]);

  const form = (
    <AddForm
      checking={checking}
      note={note}
      draft={draft}
      onDraft={setDraft}
      onNote={setNote}
      onSubmit={() => void submit()}
      onCancel={closeForm}
    />
  );

  const options = repos.map((repo) => ({ value: repo, label: projectLabel(repo, repos) }));
  const activeLabel = activeRepo ? projectLabel(activeRepo, repos) : '';
  const lists = status
    ? { merge: status.merge, staged: status.staged, changes: status.changes }
    : null;
  const clean = lists !== null && GROUPS.every((g) => lists[g.id].length === 0);
  const branch = status ? (status.branch ?? status.head?.slice(0, 7) ?? '') : '';

  return (
    <div className="scm-view" data-testid="scm-view">
      {repos.length === 0 ? (
        <div className="scm-empty" data-testid="scm-empty">
          <Icon name="git-branch" size={20} />
          <p className="scm-empty-text">No project yet</p>
          <p className="scm-empty-hint">
            Add a folder inside a git repository to see its changes here.
          </p>
          {adding ? (
            form
          ) : (
            <Button
              variant="primary"
              data-testid="scm-add-project"
              {...pressMove(() => setAdding(true))}
            >
              Add project
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="scm-bar" data-testid="scm-bar">
            <div className="scm-select">
              <Select
                value={activeRepo}
                onChange={(repo) => onChange({ scmActiveRepo: repo })}
                options={options}
                aria-label="Project"
                data-testid="scm-project-select"
              />
            </div>
            <IconButton
              label="Add project"
              data-testid="scm-add"
              {...pressMove(() => setAdding((v) => !v))}
            >
              <Icon name="plus" size={14} />
            </IconButton>
            <IconButton
              label={`Remove ${activeLabel}`}
              data-testid="scm-remove"
              {...pressMove(removeActive)}
            >
              <Icon name="close" size={14} />
            </IconButton>
            <IconButton
              label={tree ? 'View as list' : 'View as tree'}
              data-testid="scm-view-toggle"
              {...pressMove(() => onChange({ scmTree: !tree }))}
            >
              <Icon name={tree ? 'sessions' : 'folder'} size={14} />
            </IconButton>
            {batchWrites && lastDiscard !== null && (
              <IconButton
                label={`Undo last discard (${fileCount(lastDiscard.count)})`}
                disabled={busy}
                data-testid="scm-undo-discard"
                {...pressMove(() => void undoLastDiscard())}
              >
                <Icon name="undo" size={14} />
              </IconButton>
            )}
          </div>
          {comments.length > 0 && (
            <div className="scm-comments-bar" data-testid="scm-comments-bar">
              <Button
                size="sm"
                disabled={copying}
                title={`Copy ${commentCount(comments.length)} as markdown`}
                data-testid="scm-copy-comments"
                {...pressMove(() => void copyComments())}
              >
                <Icon name="comment" size={12} />
                Copy comments
              </Button>
              <Button
                size="sm"
                data-testid="scm-clear-comments"
                {...pressMove(() => void clearComments())}
              >
                Clear all comments
              </Button>
            </div>
          )}
          {adding && form}
          {status && (
            <div className="scm-meta" data-testid="scm-branch" title={activeRepo}>
              <Icon name="git-branch" size={12} />
              <span className="scm-branch-name">{branch}</span>
              {status.unborn && <span className="scm-dim">no commits yet</span>}
            </div>
          )}
          <ScrollArea fill className="scm-scroll" data-testid="scm-scroll">
            {!status && error === null && (
              <div className="scm-note" data-testid="scm-loading">
                Loading changes…
              </div>
            )}
            {error !== null && (
              <div className="scm-note" data-tone="error" role="alert" data-testid="scm-error">
                <span className="scm-note-text">
                  {status ? `Could not refresh: ${error}` : error}
                </span>
                <Button
                  size="sm"
                  data-testid="scm-retry"
                  {...pressMove(() => scmStatusStore.refresh())}
                >
                  Retry
                </Button>
              </div>
            )}
            {status?.truncated && (
              <div className="scm-note" data-testid="scm-truncated">
                This project has more changes than palmux lists, so the list is cut short.
              </div>
            )}
            {clean && (
              <div className="scm-note" data-testid="scm-clean">
                No changes
              </div>
            )}
            {lists &&
              GROUPS.map(
                (g) =>
                  lists[g.id].length > 0 && (
                    <GroupSection
                      key={`${activeRepo}:${g.id}`}
                      id={g.id}
                      title={g.title}
                      repo={activeRepo}
                      entries={lists[g.id]}
                      icons={icons}
                      tree={tree}
                      onOpen={open}
                      onOpenReview={onOpenReview}
                      writes={writes}
                    />
                  ),
              )}
          </ScrollArea>
        </>
      )}
    </div>
  );
};
