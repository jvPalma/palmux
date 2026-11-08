// ── Source Control: what a row can do ─────────────────────────────────────────
//
// One pure function decides the actions of a row, and the inline buttons and the context
// menu both draw its answer, so the two cannot disagree. It knows the group, the row and
// the project's state (`RowActionContext`), nothing about React or the network: a `run`
// hands the entries it collected to the callback the view gave it.
//
// A FOLDER acts on every entry of the group under it, taken from the group's full list and
// not from the rows on screen, so the files of a collapsed subfolder count. That list is
// cut at the status cap; while it is, a folder would act on part of itself, so the folder
// actions are disabled with the reason and the file actions stay.

import type { ScmEntry } from '@palmux/shared';
import type { IconId } from '../ui/icons';
import type { TreeRow } from './scm-tree';

export type RowActionId = 'open' | 'stage' | 'unstage' | 'discard';

export interface RowAction {
  id: RowActionId;
  label: string;
  icon: Extract<IconId, 'external' | 'plus' | 'eject' | 'undo'>;
  danger?: true;
  /** Why the action cannot run now; absent when it can. */
  disabled?: string;
  run: () => void;
}

export interface RowActionContext {
  /** The project's top, absolute. */
  top: string;
  /** The group's FULL list of entries, not the rows on screen. */
  entries: readonly ScmEntry[];
  /** The status was cut at its cap, so a folder cannot know all its files. */
  truncated: boolean;
  /** A write on this project is in flight. */
  busy: boolean;
  /** Absent when the host cannot open a file: Open file is then not offered. */
  onOpenPath?: (absolutePath: string) => void;
  onStage: (entries: ScmEntry[]) => void;
  onUnstage: (entries: ScmEntry[]) => void;
  onDiscard: (entries: ScmEntry[]) => void;
}

export const TRUNCATED_REASON = 'The list is truncated: stage this folder from a terminal';
export const BUSY_REASON = 'Writing…';
export const DELETED_REASON = 'The file is deleted';

const absolutePathOf = (top: string, path: string): string =>
  top === '/' ? `/${path}` : `${top}/${path}`;

/** The actions of a row, in the order they are drawn: Discard last. */
export function rowActions(
  group: 'merge' | 'staged' | 'changes',
  row: TreeRow,
  ctx: RowActionContext,
): RowAction[] {
  const reasonFor = (folder: boolean): string | undefined =>
    folder && ctx.truncated ? TRUNCATED_REASON : ctx.busy ? BUSY_REASON : undefined;

  /** A write action over the entries this row stands for. */
  const write = (
    id: Exclude<RowActionId, 'open'>,
    label: string,
    icon: RowAction['icon'],
    send: (entries: ScmEntry[]) => void,
    entries: () => ScmEntry[],
    folder: boolean,
  ): RowAction => {
    const reason = reasonFor(folder);
    return {
      id,
      label,
      icon,
      ...(id === 'discard' ? { danger: true as const } : {}),
      ...(reason === undefined ? {} : { disabled: reason }),
      run: () => send(entries()),
    };
  };

  if (row.kind === 'file') {
    const { entry } = row;
    const actions: RowAction[] = [];
    const onOpenPath = ctx.onOpenPath;
    if (onOpenPath) {
      actions.push({
        id: 'open',
        label: 'Open file',
        icon: 'external',
        ...(entry.status === 'D' ? { disabled: DELETED_REASON } : {}),
        run: () => onOpenPath(absolutePathOf(ctx.top, entry.path)),
      });
    }
    const one = (): ScmEntry[] => [entry];
    if (group === 'staged') {
      actions.push(write('unstage', 'Unstage', 'eject', ctx.onUnstage, one, false));
    } else if (group === 'changes') {
      actions.push(write('stage', 'Stage', 'plus', ctx.onStage, one, false));
      actions.push(write('discard', 'Discard changes', 'undo', ctx.onDiscard, one, false));
    }
    return actions;
  }

  if (group === 'merge') return [];
  const prefix = `${row.node.path}/`;
  const under = (): ScmEntry[] => ctx.entries.filter((e) => e.path.startsWith(prefix));
  if (group === 'staged') {
    return [write('unstage', 'Unstage all', 'eject', ctx.onUnstage, under, true)];
  }
  return [
    write('stage', 'Stage all', 'plus', ctx.onStage, under, true),
    write('discard', 'Discard all', 'undo', ctx.onDiscard, under, true),
  ];
}

/** Names the confirm lists before it says how many more there are. */
const CONFIRM_NAMES = 10;

/**
 * The text of the confirm before a discard. A discard has no trash, so it says what goes,
 * which of it is untracked (those files are deleted, not reverted) and how long the Undo
 * lasts.
 */
export function discardConfirmText(names: readonly string[], untrackedCount: number): string {
  const head =
    names.length === 1
      ? `Discard changes to ${names[0]}?`
      : `Discard changes to ${names.length} files?`;
  const listed = names.length > 1 ? names.slice(0, CONFIRM_NAMES) : [];
  if (names.length > CONFIRM_NAMES) listed.push(`…and ${names.length - CONFIRM_NAMES} more`);
  const blocks = [[head, ...listed].join('\n')];
  if (untrackedCount > 0) {
    blocks.push(
      `${untrackedCount} untracked ${untrackedCount === 1 ? 'file' : 'files'} will be deleted.`,
    );
  }
  blocks.push('You can undo this for 10 minutes. A server restart loses the Undo.');
  return blocks.join('\n\n');
}
