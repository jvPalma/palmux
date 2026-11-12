import { describe, expect, it, vi } from 'vitest';
import type { ScmEntry } from '@palmux/shared';
import {
  BUSY_REASON,
  DELETED_REASON,
  TRUNCATED_REASON,
  discardConfirmText,
  rowActions,
  type RowActionContext,
} from './row-actions';
import { buildTree, flattenTree, type TreeRow } from './scm-tree';

const entry = (path: string, over: Partial<ScmEntry> = {}): ScmEntry => ({
  path,
  kind: 'ordinary',
  status: 'M',
  fp: `fp-${path}`,
  ...over,
});

/** The row for `key` (`f:<path>` or `d:<path>`) of a tree over `entries`, folders collapsed as given. */
const rowOf = (entries: ScmEntry[], key: string, collapsed: string[] = []): TreeRow => {
  const row = flattenTree(buildTree(entries), new Set(collapsed)).find((r) => r.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
};

const context = (over: Partial<RowActionContext> = {}): RowActionContext => ({
  top: '/work/app',
  entries: [],
  truncated: false,
  busy: false,
  onOpenPath: vi.fn(),
  onStage: vi.fn(),
  onUnstage: vi.fn(),
  onDiscard: vi.fn(),
  ...over,
});

const ids = (actions: { id: string }[]): string[] => actions.map((a) => a.id);

describe('rowActions', () => {
  const FILES = [entry('src/a.ts'), entry('src/b.ts'), entry('c.ts')];

  it('offers each group its own actions, Discard last', () => {
    const ctx = context({ entries: FILES });
    const file = rowOf(FILES, 'f:c.ts');
    const folder = rowOf(FILES, 'd:src');

    expect(ids(rowActions('merge', file, ctx))).toEqual(['open']);
    expect(ids(rowActions('staged', file, ctx))).toEqual(['open', 'unstage']);
    expect(ids(rowActions('changes', file, ctx))).toEqual(['open', 'stage', 'discard']);

    expect(rowActions('merge', folder, ctx)).toEqual([]);
    expect(rowActions('staged', folder, ctx).map((a) => a.label)).toEqual(['Unstage all']);
    expect(rowActions('changes', folder, ctx).map((a) => a.label)).toEqual([
      'Stage all',
      'Discard all',
    ]);
  });

  it('labels and marks the actions of a changed file', () => {
    const actions = rowActions('changes', rowOf(FILES, 'f:c.ts'), context());
    expect(actions.map((a) => [a.id, a.label, a.icon])).toEqual([
      ['open', 'Open file', 'external'],
      ['stage', 'Stage', 'plus'],
      ['discard', 'Discard changes', 'undo'],
    ]);
    expect(actions.map((a) => a.danger)).toEqual([undefined, undefined, true]);
    expect(actions.every((a) => a.disabled === undefined)).toBe(true);
    expect(rowActions('staged', rowOf(FILES, 'f:c.ts'), context())[1]?.icon).toBe('eject');
  });

  it('runs a file action on that one entry, and Open file on its absolute path', () => {
    const ctx = context();
    const actions = rowActions('changes', rowOf(FILES, 'f:c.ts'), ctx);
    for (const action of actions) action.run();
    expect(ctx.onOpenPath).toHaveBeenCalledWith('/work/app/c.ts');
    expect(ctx.onStage).toHaveBeenCalledWith([FILES[2]]);
    expect(ctx.onDiscard).toHaveBeenCalledWith([FILES[2]]);
    expect(ctx.onUnstage).not.toHaveBeenCalled();
  });

  it('builds the path of a project at the root without a double slash', () => {
    const ctx = context({ top: '/' });
    rowActions('merge', rowOf(FILES, 'f:c.ts'), ctx)[0]?.run();
    expect(ctx.onOpenPath).toHaveBeenCalledWith('/c.ts');
  });

  it('does not offer Open file when the host cannot open one', () => {
    const { onOpenPath: _drop, ...rest } = context();
    const actions = rowActions('changes', rowOf(FILES, 'f:c.ts'), rest);
    expect(ids(actions)).toEqual(['stage', 'discard']);
    expect(ids(rowActions('merge', rowOf(FILES, 'f:c.ts'), rest))).toEqual([]);
  });

  it('disables Open file on a deleted file with the reason, and leaves the rest alone', () => {
    const gone = [entry('gone.ts', { status: 'D' })];
    const actions = rowActions('changes', rowOf(gone, 'f:gone.ts'), context());
    expect(actions[0]).toMatchObject({ id: 'open', disabled: DELETED_REASON });
    expect(DELETED_REASON).toBe('The file is deleted');
    expect(actions[1]?.disabled).toBeUndefined();
    expect(actions[2]?.disabled).toBeUndefined();
  });

  it('collects every entry under a folder, collapsed descendants included', () => {
    const entries = [
      entry('src/a.ts'),
      entry('src/deep/b.ts'),
      entry('src/deep/er/c.ts'),
      entry('srcs/d.ts'),
      entry('e.ts'),
    ];
    const ctx = context({ entries });
    const row = rowOf(entries, 'd:src', ['src']);
    const actions = rowActions('changes', row, ctx);
    for (const action of actions) action.run();
    const expected = [entries[0], entries[1], entries[2]];
    expect(ctx.onStage).toHaveBeenCalledWith(expected);
    expect(ctx.onDiscard).toHaveBeenCalledWith(expected);
    rowActions('staged', row, ctx)[0]?.run();
    expect(ctx.onUnstage).toHaveBeenCalledWith(expected);
  });

  it('collects from the group’s full list, not from the tree it was drawn from', () => {
    const drawn = [entry('src/a.ts')];
    const full = [entry('src/a.ts'), entry('src/z.ts')];
    const ctx = context({ entries: full });
    rowActions('changes', rowOf(drawn, 'd:src'), ctx)[0]?.run();
    expect(ctx.onStage).toHaveBeenCalledWith(full);
  });

  it('disables the folder actions while the list is truncated, and keeps the file ones', () => {
    const ctx = context({ entries: FILES, truncated: true });
    const folder = rowActions('changes', rowOf(FILES, 'd:src'), ctx);
    expect(folder.map((a) => a.disabled)).toEqual([TRUNCATED_REASON, TRUNCATED_REASON]);
    expect(TRUNCATED_REASON).toBe('The list is truncated: stage this folder from a terminal');
    const file = rowActions('changes', rowOf(FILES, 'f:c.ts'), ctx);
    expect(file.map((a) => a.disabled)).toEqual([undefined, undefined, undefined]);
    const staged = rowActions('staged', rowOf(FILES, 'd:src'), ctx);
    expect(staged[0]?.disabled).toBe(TRUNCATED_REASON);
  });

  it('disables every write while one is in flight, but not Open file', () => {
    const ctx = context({ entries: FILES, busy: true });
    const file = rowActions('changes', rowOf(FILES, 'f:c.ts'), ctx);
    expect(file.map((a) => a.disabled)).toEqual([undefined, BUSY_REASON, BUSY_REASON]);
    expect(BUSY_REASON).toBe('Writing…');
    const folder = rowActions('changes', rowOf(FILES, 'd:src'), ctx);
    expect(folder.map((a) => a.disabled)).toEqual([BUSY_REASON, BUSY_REASON]);
    expect(rowActions('staged', rowOf(FILES, 'f:c.ts'), ctx)[1]?.disabled).toBe(BUSY_REASON);
  });
});

describe('discardConfirmText', () => {
  const UNDO = 'You can undo this for 10 minutes. A server restart loses the Undo.';

  it('names the one file and says how long the Undo lasts', () => {
    expect(discardConfirmText(['src/a.ts'], 0)).toBe(`Discard changes to src/a.ts?\n\n${UNDO}`);
  });

  it('lists ten names and counts the rest', () => {
    const names = Array.from({ length: 12 }, (_, i) => `f${i + 1}.ts`);
    const lines = discardConfirmText(names, 0).split('\n');
    expect(lines[0]).toBe('Discard changes to 12 files?');
    expect(lines.slice(1, 11)).toEqual(names.slice(0, 10));
    expect(lines[11]).toBe('…and 2 more');
    expect(lines.at(-1)).toBe(UNDO);
    expect(lines).not.toContain('f11.ts');
  });

  it('lists every name when there are ten or fewer, with no "more" line', () => {
    const names = Array.from({ length: 10 }, (_, i) => `f${i + 1}.ts`);
    const text = discardConfirmText(names, 0);
    expect(text).toContain('f10.ts');
    expect(text).not.toContain('more');
  });

  it('says untracked files are deleted, in the singular for one', () => {
    expect(discardConfirmText(['a.ts', 'b.ts'], 2)).toBe(
      `Discard changes to 2 files?\na.ts\nb.ts\n\n2 untracked files will be deleted.\n\n${UNDO}`,
    );
    expect(discardConfirmText(['new.ts'], 1)).toBe(
      `Discard changes to new.ts?\n\n1 untracked file will be deleted.\n\n${UNDO}`,
    );
  });
});
