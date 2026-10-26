// Comments in the review pane, scenario by scenario from `review-comments`: picking
// lines (a drag and shift-click on desktop, tap then tap on a phone), the inline
// editor, edit and delete, the outdated list, and what survives. The pane is real;
// the server is `FakeServer`, whose comments store answers the whole list and its
// rev like the real one.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { parse, type Rule } from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeServer,
  OTHER,
  REPO,
  colorize,
  editedAt,
  entry,
  mountReview,
  newNumber,
  oldNumber,
  scrollTo,
  scroller,
  settle,
  setup,
  snapshot,
  statusBody,
  tab,
  teardown,
  hunk,
  lines,
  type StoredComment,
} from './review-test-support';
import { scmStatusStore } from '../scm/status-store';
import { commentsStore } from './use-comments';

vi.mock('../panes/monaco-loader', () => ({
  getMonaco: () => ({ editor: { colorize: (text: string) => colorize(text) } }),
}));

let server: FakeServer;
beforeEach(() => {
  server = setup();
});
afterEach(teardown);

// ── Driving a pointer ────────────────────────────────────────────────────────

const mouseDown = (el: Element, init: Record<string, unknown> = {}) =>
  fireEvent.pointerDown(el, { pointerType: 'mouse', pointerId: 1, button: 0, ...init });
const mouseUp = (el: Element | Window = window) =>
  fireEvent.pointerUp(el, { pointerType: 'mouse', pointerId: 1, button: 0 });
const click = (el: Element, init: Record<string, unknown> = {}) => {
  mouseDown(el, init);
  mouseUp(el);
};
const tap = (el: Element) => {
  fireEvent.pointerDown(el, { pointerType: 'touch', pointerId: 2, clientX: 5, clientY: 5 });
  fireEvent.pointerUp(el, { pointerType: 'touch', pointerId: 2, clientX: 5, clientY: 5 });
};
const drag = (from: Element, ...over: Element[]) => {
  mouseDown(from);
  for (const el of over) fireEvent.pointerOver(el, { pointerType: 'mouse', pointerId: 1 });
  mouseUp();
};

/** Open a Changes review of one file with a change at line 42 of 50, loaded. */
async function open(path = 'a.ts', at = 42, over: Parameters<typeof editedAt>[3] = {}) {
  server.status[REPO] = statusBody({ changes: [entry(path)] });
  server.files[path] = editedAt(path, at, 50, over);
  const pane = mountReview();
  await screen.findByTestId('review-list');
  await settle();
  return pane;
}

const input = () => screen.getByTestId('review-comment-input') as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const save = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('review-comment-save'));
  });
  await settle();
};
const chooseComment = () => fireEvent.click(screen.getByTestId('review-comment-start'));
const posts = () => server.requests('/scm/comments').filter((r) => r.method === 'POST');

/** A stored comment on `a.ts`, as the review stores one (three lines of context). */
function stored(start: number, end: number, over: Partial<StoredComment> = {}): StoredComment {
  const text = lines(50, { 42: 'edited 42' });
  return {
    id: `s${start}`,
    path: 'a.ts',
    version: 'worktree',
    side: 'new',
    start,
    end,
    lines: text.slice(start - 1, end),
    before: text.slice(Math.max(0, start - 4), start - 1),
    after: text.slice(end, end + 3),
    body: `note on ${start}`,
    createdAt: start,
    updatedAt: start,
    ...over,
  };
}

// ── A comment attaches to a line or a range on one side ──────────────────────

describe('A comment attaches to a line or a range on one side', () => {
  it('a one-line comment shows under line 42, and line 42 is marked as commented', async () => {
    await open();
    click(newNumber(42));
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('a.ts · L42 · new');
    chooseComment();
    expect(input()).toHaveFocus();
    type('rename this');
    await save();

    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.query['repo']).toBe(REPO);
    expect(posts()[0]?.body).toEqual({
      path: 'a.ts',
      version: 'worktree',
      side: 'new',
      start: 42,
      end: 42,
      lines: ['edited 42'],
      before: ['line 39', 'line 40', 'line 41'],
      after: ['line 43', 'line 44', 'line 45'],
      body: 'rename this',
    });
    const card = screen.getByTestId('review-comment');
    expect(card).toHaveTextContent('rename this');
    expect(within(card).getByTestId('review-comment-range')).toHaveTextContent('L42 · new');
    // Under line 42's row, and the editor is gone.
    const rows = [...scroller().querySelectorAll('[data-rv-key]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    const at = rows.indexOf('review-comment-row');
    expect(at).toBeGreaterThan(0);
    expect(newNumber(42).className).toContain('rv-commented');
    expect(screen.queryByTestId('review-comment-editor')).toBeNull();
    expect(screen.queryByTestId('review-selection')).toBeNull();
  });

  it('stores the old side of a removed line as the old side, from the old text', async () => {
    await open();
    click(oldNumber(42));
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('L42 · old');
    chooseComment();
    type('why remove');
    await save();
    expect(posts()[0]?.body).toMatchObject({
      side: 'old',
      version: 'index',
      start: 42,
      end: 42,
      lines: ['line 42'],
    });
  });

  it('a range on a phone: tap line 40, tap line 44, then Comment covers 40 to 44 of that side', async () => {
    await open();
    tap(newNumber(40));
    // One tap already picks one line, so a one-line comment is a tap and a button.
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('L40 · new');
    tap(newNumber(44));
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('L40–44 · new');
    chooseComment();
    type('this block');
    await save();
    expect(posts()[0]?.body).toMatchObject({
      start: 40,
      end: 44,
      lines: ['line 40', 'line 41', 'edited 42', 'line 43', 'line 44'],
      before: ['line 37', 'line 38', 'line 39'],
    });
    expect(screen.getByTestId('review-comment-range')).toHaveTextContent('L40–44');
    for (const no of [40, 41, 42, 43, 44])
      expect(newNumber(no).className).toContain('rv-commented');
  });

  it('a third tap starts again instead of widening a settled range', async () => {
    await open();
    tap(newNumber(40));
    tap(newNumber(42));
    tap(newNumber(45));
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('L45 · new');
  });

  it('a mouse drag across the line numbers picks the range, whichever way it runs', async () => {
    await open();
    drag(newNumber(44), newNumber(43), newNumber(42));
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('L42–44 · new');
    // The numbers under the drag are highlighted as picked.
    for (const no of [42, 43, 44]) expect(newNumber(no).className).toContain('rv-selected');
    expect(newNumber(45).className).not.toContain('rv-selected');
  });

  it('no Comment button while the mouse is still down', async () => {
    await open();
    mouseDown(newNumber(41));
    fireEvent.pointerOver(newNumber(43), { pointerType: 'mouse', pointerId: 1 });
    expect(screen.queryByTestId('review-selection')).toBeNull();
    mouseUp();
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('L41–43 · new');
  });

  it('shift-click widens the range already picked', async () => {
    await open();
    click(newNumber(40));
    click(newNumber(44), { shiftKey: true });
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('L40–44 · new');
  });

  it('a plain click on another number picks that one alone', async () => {
    await open();
    click(newNumber(40));
    click(newNumber(44));
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('L44 · new');
  });

  it('a drag does not cross to the other side', async () => {
    await open();
    mouseDown(newNumber(43));
    fireEvent.pointerOver(oldNumber(41), { pointerType: 'mouse', pointerId: 1 });
    mouseUp();
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('L43 · new');
  });

  it('clearing the pick leaves nothing picked', async () => {
    await open();
    click(newNumber(41));
    fireEvent.click(screen.getByTestId('review-selection-clear'));
    expect(screen.queryByTestId('review-selection')).toBeNull();
    expect(newNumber(41).className).not.toContain('rv-selected');
  });

  it('a finger that panned across a number picks nothing', async () => {
    await open();
    const el = newNumber(41);
    fireEvent.pointerDown(el, { pointerType: 'touch', pointerId: 2, clientX: 5, clientY: 5 });
    fireEvent.pointerMove(el, { pointerType: 'touch', pointerId: 2, clientX: 5, clientY: 80 });
    fireEvent.pointerUp(el, { pointerType: 'touch', pointerId: 2, clientX: 5, clientY: 80 });
    expect(screen.queryByTestId('review-selection')).toBeNull();
  });

  it('keeps a pick to one file', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.ts'), entry('b.ts')] });
    server.files['a.ts'] = editedAt('a.ts', 42);
    server.files['b.ts'] = editedAt('b.ts', 42);
    mountReview();
    await screen.findByTestId('review-list');
    await settle();
    click(newNumber(41));
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('a.ts · L41');
  });
});

// ── The editor ───────────────────────────────────────────────────────────────

describe('Comments can be edited and deleted', () => {
  it('Esc cancels the editor and drops its draft, saving nothing', async () => {
    await open();
    click(newNumber(42));
    chooseComment();
    type('half a thou');
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByTestId('review-comment-editor')).toBeNull();
    expect(posts()).toEqual([]);
    expect(commentsStore.getSnapshot().drafts).toEqual([]);
  });

  it('Cancel does the same', async () => {
    await open();
    click(newNumber(42));
    chooseComment();
    fireEvent.click(screen.getByTestId('review-comment-cancel'));
    expect(screen.queryByTestId('review-comment-editor')).toBeNull();
    expect(commentsStore.getSnapshot().drafts).toEqual([]);
  });

  it('a draft survives scrolling it out of view and back, unsaved and intact', async () => {
    // A long hunk, so the editor's row is far from the rows around the bottom.
    const long = snapshot('a.ts', {
      old: { id: 'o', text: `${lines(400).join('\n')}\n` },
      new: { id: 'n', text: `${lines(400).join('\n')}\n` },
      hunks: [hunk(lines(400).map((text): ['ctx', string] => ['ctx', text]))],
    });
    server.status[REPO] = statusBody({ changes: [entry('a.ts')] });
    server.files['a.ts'] = long;
    mountReview();
    await screen.findByTestId('review-list');
    await settle();
    click(newNumber(3));
    chooseComment();
    type('still typing, not saved');
    expect(input().value).toBe('still typing, not saved');

    scrollTo(6000);
    await settle();
    // The row left the list: ten files' worth away, nothing of it is mounted.
    expect(screen.queryByTestId('review-comment-input')).toBeNull();
    expect(posts()).toEqual([]);

    scrollTo(0);
    await settle();
    expect(input().value).toBe('still typing, not saved');
    // And it did not take focus from wherever the reader had put it.
    expect(input()).not.toHaveFocus();
    expect(posts()).toEqual([]);
  });

  it('shows the server’s refusal under the text, and keeps the draft', async () => {
    await open();
    click(newNumber(42));
    chooseComment();
    type('too much');
    server.commentRefusals.push({ status: 400, body: { error: 'body is too long' } });
    await save();
    expect(screen.getByTestId('review-comment-error')).toHaveTextContent('body is too long');
    expect(input().value).toBe('too much');
    expect(input()).not.toBeDisabled();
    // A second try goes through.
    await save();
    expect(screen.getByTestId('review-comment')).toHaveTextContent('too much');
  });

  it('edits a stored comment in place, with a patch to the server', async () => {
    server.comments = [stored(42, 42)];
    server.rev = 1;
    await open();
    expect(screen.getByTestId('review-comment')).toHaveTextContent('note on 42');
    fireEvent.click(screen.getByTestId('review-comment-edit'));
    expect(screen.queryByTestId('review-comment')).toBeNull();
    expect(input().value).toBe('note on 42');
    expect(input()).toHaveFocus();
    type('note on 42, reworded');
    await save();
    const patch = server.requests('/scm/comments').find((r) => r.method === 'PATCH');
    expect(patch?.query['id']).toBe('s42');
    expect(patch?.body).toEqual({ body: 'note on 42, reworded' });
    expect(screen.getByTestId('review-comment')).toHaveTextContent('note on 42, reworded');
  });

  it('asks once before deleting a comment that has text, and deletes on yes', async () => {
    server.comments = [stored(42, 42)];
    server.rev = 1;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await open();
    fireEvent.click(screen.getByTestId('review-comment-delete'));
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    const del = server.requests('/scm/comments').find((r) => r.method === 'DELETE');
    expect(del?.query['id']).toBe('s42');
    expect(screen.queryByTestId('review-comment')).toBeNull();
  });

  it('deletes nothing when the question is answered no', async () => {
    server.comments = [stored(42, 42)];
    server.rev = 1;
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await open();
    fireEvent.click(screen.getByTestId('review-comment-delete'));
    await settle();
    expect(server.requests('/scm/comments').some((r) => r.method === 'DELETE')).toBe(false);
    expect(screen.getByTestId('review-comment')).toBeInTheDocument();
  });

  it('asks nothing before deleting an empty comment', async () => {
    server.comments = [stored(42, 42, { body: '' })];
    server.rev = 1;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await open();
    fireEvent.click(screen.getByTestId('review-comment-delete'));
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(server.comments).toEqual([]);
  });

  it('says so when a delete fails', async () => {
    server.comments = [stored(42, 42, { body: '' })];
    server.rev = 1;
    await open();
    server.commentRefusals.push({ status: 500, body: { error: 'source control request failed' } });
    fireEvent.click(screen.getByTestId('review-comment-delete'));
    await settle();
    expect(screen.getByTestId('review-notice')).toHaveTextContent('source control request failed');
    expect(screen.getByTestId('review-comment')).toBeInTheDocument();
  });
});

// ── Comments stay attached to their code ─────────────────────────────────────

describe('Comments stay attached to their code', () => {
  it('draws every stored comment of the file under its line', async () => {
    server.comments = [stored(41, 41), stored(42, 43, { id: 's42' })];
    server.rev = 2;
    await open();
    const cards = screen.getAllByTestId('review-comment');
    expect(cards.map((c) => c.dataset['commentId'])).toEqual(['s41', 's42']);
    expect(within(cards[1] as HTMLElement).getByTestId('review-comment-range')).toHaveTextContent(
      'L42–43',
    );
  });

  it('lists a comment whose code is gone, with the code it was about, on no line', async () => {
    server.comments = [
      stored(42, 42, {
        id: 'gone',
        lines: ['this line was deleted'],
        before: ['and its'],
        after: ['neighbours'],
        start: 20,
        end: 20,
      }),
    ];
    server.rev = 1;
    await open();
    expect(screen.queryByTestId('review-comment-row')).toBeNull();
    const list = screen.getByTestId('review-unplaced-list');
    expect(within(list).getByTestId('review-comment-flag')).toHaveTextContent('Outdated');
    expect(within(list).getByTestId('review-comment-quote')).toHaveTextContent(
      'this line was deleted',
    );
    expect(within(list).getByTestId('review-comment-body')).toHaveTextContent('note on 42');
    // No line number is marked for it.
    expect(document.querySelectorAll('.rv-commented')).toHaveLength(0);
  });

  it('edits and deletes a comment in the outdated list too', async () => {
    server.comments = [stored(42, 42, { id: 'gone', lines: ['deleted'], before: [], after: [] })];
    server.rev = 1;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await open();
    fireEvent.click(screen.getByTestId('review-comment-edit'));
    expect(input().value).toBe('note on 42');
    type('still true');
    await save();
    expect(screen.getByTestId('review-comment-body')).toHaveTextContent('still true');
    fireEvent.click(screen.getByTestId('review-comment-delete'));
    await settle();
    expect(screen.queryByTestId('review-unplaced-list')).toBeNull();
  });

  it('shows a comment made on Changes on the same line of Staged: it survives Reviewed', async () => {
    // Made against the work tree's new side; after Reviewed that text is the index.
    server.comments = [stored(42, 42, { version: 'worktree', side: 'new' })];
    server.rev = 1;
    server.status[REPO] = statusBody({ staged: [entry('a.ts')] });
    server.files['a.ts'] = editedAt('a.ts', 42, 50, { group: 'staged' });
    mountReview({ tab: tab(`staged:${REPO}`) });
    await screen.findByTestId('review-list');
    await settle();
    const card = screen.getByTestId('review-comment');
    expect(card).toHaveTextContent('note on 42');
    expect(within(card).getByTestId('review-comment-range')).toHaveTextContent('L42 · new');
    expect(newNumber(42).className).toContain('rv-commented');
  });

  it('keeps a comment on the old side when only the old side holds its code', async () => {
    server.comments = [
      stored(42, 42, { side: 'old', version: 'index', lines: ['line 42'], after: ['line 43'] }),
    ];
    server.rev = 1;
    await open();
    expect(
      within(screen.getByTestId('review-comment')).getByTestId('review-comment-range'),
    ).toHaveTextContent('L42 · old');
    expect(oldNumber(42).className).toContain('rv-commented');
    expect(newNumber(42).className).not.toContain('rv-commented');
  });
});

// ── Comments belong to the project this device reads ─────────────────────────

describe('a review of a project that is not the active one', () => {
  async function paused() {
    server.status[OTHER] = statusBody({ changes: [entry('a.ts')] }, OTHER);
    server.status[REPO] = statusBody({ changes: [entry('a.ts')] });
    server.files['a.ts'] = editedAt('a.ts', 42);
    // Read once as the active project, then the device moves to another.
    mountReview({ repos: [REPO, OTHER] });
    await screen.findByTestId('review-list');
    await settle();
    act(() => {
      scmStatusStore.setActiveRepo(OTHER);
      commentsStore.setActiveRepo(OTHER);
    });
    await settle();
  }

  it('keeps the lines but picks nothing: its comments could land in the other project', async () => {
    await paused();
    expect(screen.getByTestId('review-paused')).toBeInTheDocument();
    click(newNumber(41));
    tap(newNumber(41));
    expect(screen.queryByTestId('review-selection')).toBeNull();
    expect(newNumber(41).className).not.toContain('rv-selected');
  });

  it('shows the comments it last had, and cannot edit or delete them', async () => {
    server.comments = [stored(42, 42)];
    server.rev = 1;
    server.status[OTHER] = statusBody({ changes: [entry('a.ts')] }, OTHER);
    server.status[REPO] = statusBody({ changes: [entry('a.ts')] });
    server.files['a.ts'] = editedAt('a.ts', 42);
    mountReview({ repos: [REPO, OTHER] });
    await screen.findByTestId('review-list');
    await settle();
    expect(screen.getByTestId('review-comment')).toBeInTheDocument();
    act(() => {
      scmStatusStore.setActiveRepo(OTHER);
      commentsStore.setActiveRepo(OTHER);
    });
    await settle();
    expect(screen.getByTestId('review-comment')).toBeInTheDocument();
    expect(screen.getByTestId('review-comment-edit')).toBeDisabled();
    expect(screen.getByTestId('review-comment-delete')).toBeDisabled();
  });
});

// ── Two reviews of one file ──────────────────────────────────────────────────

describe('a draft belongs to the review that opened it', () => {
  it('is typed into one editor, though the file’s other review shows the same lines', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.ts')], staged: [entry('a.ts')] });
    server.files['changes:a.ts'] = editedAt('a.ts', 42);
    server.files['staged:a.ts'] = editedAt('a.ts', 42, 50, { group: 'staged' });
    mountReview();
    mountReview({ tab: tab(`staged:${REPO}`, '8') });
    await settle();
    const changes = within(screen.getByTestId('review-pane-7'));
    const staged = within(screen.getByTestId('review-pane-8'));

    click(newNumber(42, changes));
    fireEvent.click(changes.getByTestId('review-comment-start'));
    await settle();
    expect(changes.getAllByTestId('review-comment-editor')).toHaveLength(1);
    expect(staged.queryByTestId('review-comment-editor')).toBeNull();
    expect(commentsStore.getSnapshot().drafts).toEqual([
      { path: 'a.ts', side: 'new', start: 42, end: 42, scope: 'changes' },
    ]);
  });

  it('is saved as a comment on the version of the review it was made in', async () => {
    server.status[REPO] = statusBody({ staged: [entry('a.ts')] });
    server.files['a.ts'] = editedAt('a.ts', 42, 50, { group: 'staged' });
    mountReview({ tab: tab(`staged:${REPO}`) });
    await settle();
    click(newNumber(42));
    chooseComment();
    type('on the staged side');
    await save();
    // Staged compares HEAD with the index: its new side is the index.
    expect(posts()[0]?.body).toMatchObject({ version: 'index', side: 'new' });
  });
});

// ── Two windows ──────────────────────────────────────────────────────────────

describe('Two windows at once', () => {
  it('shows a comment another window added once an scmComments frame arrives', async () => {
    await open();
    expect(screen.queryByTestId('review-comment')).toBeNull();
    // Another window writes; this one hears the frame and reads the list.
    server.comments = [stored(42, 42)];
    server.rev = 5;
    act(() => commentsStore.observeRev(REPO, 5));
    await settle();
    expect(screen.getByTestId('review-comment')).toHaveTextContent('note on 42');
    // And a delete elsewhere takes it off the screen.
    server.comments = [];
    server.rev = 6;
    act(() => commentsStore.observeRev(REPO, 6));
    await settle();
    expect(screen.queryByTestId('review-comment')).toBeNull();
  });
});

// ── A hidden review ──────────────────────────────────────────────────────────

describe('a hidden review', () => {
  it('reads no comments until it is shown', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.ts')] });
    server.files['a.ts'] = editedAt('a.ts', 42);
    const pane = mountReview({ visible: false });
    await settle();
    expect(server.requests('/scm/comments')).toEqual([]);
    pane.show(true);
    await settle();
    expect(server.requests('/scm/comments').length).toBeGreaterThan(0);
  });
});

// ── Line numbers are reachable without a pointer ─────────────────────────────

describe('Line numbers are reachable by keyboard', () => {
  const key = (el: Element, init: Record<string, unknown>) => fireEvent.keyDown(el, init);

  it('a number is a button in the tab order, named by its line and its side', async () => {
    await open();
    for (const [cell, label] of [
      [newNumber(42), 'Line 42, new side'],
      [oldNumber(42), 'Line 42, old side'],
    ] as const) {
      expect(cell).toHaveAttribute('role', 'button');
      expect(cell).toHaveAttribute('tabindex', '0');
      expect(cell).toHaveAttribute('aria-label', label);
    }
  });

  it('a cell with no number on that side is not a button', async () => {
    await open();
    // An added line has no old number.
    const empty = screen.getAllByTestId('review-no-old').find((el) => el.textContent === '');
    expect(empty).toBeDefined();
    expect(empty).not.toHaveAttribute('role');
    expect(empty).not.toHaveAttribute('tabindex');
  });

  it('Enter picks the line, and Comment then opens its editor', async () => {
    await open();
    key(newNumber(42), { key: 'Enter' });
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('a.ts · L42 · new');
    expect(newNumber(42).className).toContain('rv-selected');
    chooseComment();
    type('from the keyboard');
    await save();
    expect(posts()[0]?.body).toMatchObject({ side: 'new', start: 42, end: 42 });
  });

  it('Space picks it too, and keeps the key from scrolling the list', async () => {
    await open();
    const notPrevented = key(newNumber(41), { key: ' ' });
    expect(notPrevented).toBe(false);
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('a.ts · L41 · new');
  });

  it('Shift+Enter and Shift+Space widen the pick, either way round', async () => {
    await open();
    key(newNumber(40), { key: 'Enter' });
    key(newNumber(44), { key: 'Enter', shiftKey: true });
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('L40–44 · new');
    key(newNumber(39), { key: ' ', shiftKey: true });
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('L39–40 · new');
  });

  it('a plain Enter on another number starts again, and Shift never crosses to the other side', async () => {
    await open();
    key(newNumber(40), { key: 'Enter' });
    key(newNumber(44), { key: 'Enter' });
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('L44 · new');
    key(oldNumber(41), { key: 'Enter', shiftKey: true });
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('L41 · old');
  });

  it('a pick made by key is a settled range: Comment is offered at once', async () => {
    await open();
    key(newNumber(42), { key: 'Enter' });
    expect(screen.getByTestId('review-comment-start')).toBeInTheDocument();
  });

  it('other keys do nothing', async () => {
    await open();
    key(newNumber(42), { key: 'a' });
    key(newNumber(42), { key: 'Tab' });
    expect(screen.queryByTestId('review-selection')).toBeNull();
  });

  it('leaves the pointer as it was: a click still picks on press, a tap on release', async () => {
    await open();
    mouseDown(newNumber(42));
    expect(newNumber(42).className).toContain('rv-selected');
    mouseUp();
    tap(newNumber(44));
    expect(screen.getByTestId('review-selection-text')).toHaveTextContent('L44 · new');
  });

  it('draws a focus ring only for the keyboard (:focus-visible)', () => {
    const css = readFileSync(join(__dirname, 'review.css'), 'utf8');
    const rule = parse(css)
      .nodes.filter((n): n is Rule => n.type === 'rule')
      .find((r) => r.selector === ".rv-no[role='button']:focus-visible");
    expect(rule, 'a :focus-visible rule for the line numbers').toBeDefined();
    const outline = rule?.nodes.find((n) => n.type === 'decl' && n.prop === 'outline');
    expect(outline && 'value' in outline ? outline.value : '').toMatch(/solid var\(--t-accent\)/);
    // And nothing cancels it: a plain `:focus` reset would erase the keyboard's ring.
    expect(css).not.toMatch(/\.rv-no[^{]*:focus\s*{[^}]*outline:\s*(none|0)/);
  });
});

describe('a review that cannot be written to has no line buttons', () => {
  it('draws the numbers as plain text when the project is paused', async () => {
    server.status[OTHER] = statusBody({ changes: [entry('a.ts')] }, OTHER);
    server.status[REPO] = statusBody({ changes: [entry('a.ts')] });
    server.files['a.ts'] = editedAt('a.ts', 42);
    mountReview({ repos: [REPO, OTHER] });
    await screen.findByTestId('review-list');
    await settle();
    expect(newNumber(42)).toHaveAttribute('role', 'button');
    act(() => {
      scmStatusStore.setActiveRepo(OTHER);
      commentsStore.setActiveRepo(OTHER);
    });
    await settle();
    expect(newNumber(42)).not.toHaveAttribute('role');
    expect(newNumber(42)).not.toHaveAttribute('tabindex');
  });
});

// ── Where a comment in a gap is listed ───────────────────────────────────────

describe('a comment in a hidden part of the file', () => {
  it('is listed at the lines the anchor found, not the ones it was stored with', async () => {
    // Stored at line 3 (the file has had lines inserted above since); its code is
    // now at line 10, which the hunk at 42 does not draw.
    server.comments = [
      stored(10, 10, { id: 'moved', start: 3, end: 3, body: 'moved by an insert above' }),
    ];
    server.rev = 1;
    await open();
    const list = screen.getByTestId('review-unplaced-list');
    expect(within(list).getByTestId('review-comment-flag')).toHaveTextContent(
      'In a hidden part of the file',
    );
    expect(within(list).getByTestId('review-comment-range')).toHaveTextContent('L10 · new');
    expect(within(list).getByTestId('review-comment-range')).not.toHaveTextContent('L3 ');
    expect(within(list).getByTestId('review-comment-quote')).toHaveTextContent('line 10');
  });

  it('keeps the side and the range of a multi-line comment that moved', async () => {
    server.comments = [
      stored(10, 12, { id: 'span', start: 1, end: 3, lines: ['line 10', 'line 11', 'line 12'] }),
    ];
    server.rev = 1;
    await open();
    expect(screen.getByTestId('review-comment-range')).toHaveTextContent('L10–12 · new');
  });
});

// ── A comment on a file palmux did not read ──────────────────────────────────

describe('a comment on a file that is too large or converted', () => {
  function unread(over: Partial<ReturnType<typeof snapshot>>) {
    const held = snapshot('a.ts', {
      old: { id: 'o', text: '' },
      new: { id: 'n', text: '' },
      hunks: [],
      ...over,
    });
    delete held.token;
    return held;
  }

  it.each([
    ['too large', { tooLarge: true }],
    ['converted', { converted: true }],
  ] as const)('is marked "not shown", never outdated, when the file is %s', async (_name, over) => {
    server.comments = [stored(42, 42, { id: 'on-big' })];
    server.rev = 1;
    server.status[REPO] = statusBody({ changes: [entry('a.ts')] });
    server.files['a.ts'] = unread(over);
    mountReview();
    await screen.findByTestId('review-list');
    await settle();
    const list = screen.getByTestId('review-unplaced-list');
    const flag = within(list).getByTestId('review-comment-flag');
    expect(flag).toHaveTextContent('Not shown (file too large / converted)');
    expect(flag).not.toHaveTextContent('Outdated');
    expect(within(list).getByTestId('review-comment')).toHaveAttribute('data-unplaced', 'unread');
    // The code it was about is quoted, since the file cannot show it.
    expect(within(list).getByTestId('review-comment-quote')).toHaveTextContent('edited 42');
    expect(document.querySelectorAll('.rv-commented')).toHaveLength(0);
  });

  it('can still be edited and deleted from the list', async () => {
    server.comments = [stored(42, 42, { id: 'on-big' })];
    server.rev = 1;
    server.status[REPO] = statusBody({ changes: [entry('a.ts')] });
    server.files['a.ts'] = unread({ tooLarge: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mountReview();
    await screen.findByTestId('review-list');
    await settle();
    fireEvent.click(screen.getByTestId('review-comment-edit'));
    type('still stands');
    await save();
    expect(screen.getByTestId('review-comment-body')).toHaveTextContent('still stands');
    fireEvent.click(screen.getByTestId('review-comment-delete'));
    await settle();
    expect(screen.queryByTestId('review-unplaced-list')).toBeNull();
  });

  it('a readable file whose code is gone is still outdated', async () => {
    server.comments = [stored(42, 42, { id: 'gone', lines: ['deleted'], before: [], after: [] })];
    server.rev = 1;
    await open();
    expect(screen.getByTestId('review-comment-flag')).toHaveTextContent('Outdated');
  });
});

// ── An edit whose comment was deleted in another window ──────────────────────

describe('an edit whose comment another window deleted', () => {
  /** Open the edit of the comment on line 42, type into it, then let another window delete it. */
  async function orphaned(text = 'my reworded note') {
    server.comments = [stored(42, 42)];
    server.rev = 1;
    await open();
    fireEvent.click(screen.getByTestId('review-comment-edit'));
    type(text);
    server.comments = [];
    server.rev = 2;
    act(() => commentsStore.observeRev(REPO, 2));
    await settle();
  }

  it('does not vanish: it stays, with its text, and says what happened', async () => {
    await orphaned();
    const editor = screen.getByTestId('review-comment-editor');
    expect(editor).toHaveAttribute('data-orphaned', 'true');
    expect(input().value).toBe('my reworded note');
    expect(screen.getByTestId('review-comment-orphaned')).toHaveTextContent(
      'deleted in another window',
    );
    // The code the comment was about is quoted: nothing else says where it was.
    expect(within(editor).getByTestId('review-comment-quote')).toHaveTextContent('edited 42');
    expect(commentsStore.getSnapshot().drafts).toHaveLength(1);
  });

  it('offers Save as new and Discard instead of Save and Cancel', async () => {
    await orphaned();
    expect(screen.getByTestId('review-comment-save-new')).toHaveTextContent('Save as new');
    expect(screen.getByTestId('review-comment-discard')).toHaveTextContent('Discard');
    expect(screen.queryByTestId('review-comment-save')).toBeNull();
    expect(screen.queryByTestId('review-comment-cancel')).toBeNull();
  });

  it('Save as new stores a NEW comment on the code the old one had, and closes the draft', async () => {
    await orphaned();
    await act(async () => {
      fireEvent.click(screen.getByTestId('review-comment-save-new'));
    });
    await settle();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.body).toEqual({
      path: 'a.ts',
      version: 'worktree',
      side: 'new',
      start: 42,
      end: 42,
      lines: ['edited 42'],
      before: ['line 39', 'line 40', 'line 41'],
      after: ['line 43', 'line 44', 'line 45'],
      body: 'my reworded note',
    });
    // No PATCH went to a comment that does not exist.
    expect(server.requests('/scm/comments').filter((r) => r.method === 'PATCH')).toEqual([]);
    expect(screen.queryByTestId('review-comment-editor')).toBeNull();
    expect(screen.getByTestId('review-comment')).toHaveTextContent('my reworded note');
    expect(commentsStore.getSnapshot().drafts).toEqual([]);
  });

  it('Discard closes the draft and stores nothing', async () => {
    await orphaned();
    fireEvent.click(screen.getByTestId('review-comment-discard'));
    expect(screen.queryByTestId('review-comment-editor')).toBeNull();
    expect(posts()).toEqual([]);
    expect(commentsStore.getSnapshot().drafts).toEqual([]);
  });

  it('keeps the file in the review until the orphan is dealt with: Reviewed asks first', async () => {
    await orphaned();
    const reviewed = screen.getByTestId('review-file-reviewed');
    expect(reviewed).toBeDisabled();
    expect(reviewed.getAttribute('data-reason')).toMatch(/Save or cancel the comment on a\.ts/);
  });

  it('Esc on its textarea discards it, as on any editor', async () => {
    await orphaned();
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByTestId('review-comment-editor')).toBeNull();
    expect(commentsStore.getSnapshot().drafts).toEqual([]);
  });

  it('is not taken for an orphan while the comments are still loading', async () => {
    // A pane that mounts with an edit already open (it remounted) has not heard the
    // list yet; the comment is not known to be gone, only not known.
    server.comments = [stored(42, 42)];
    server.rev = 1;
    server.status[REPO] = statusBody({ changes: [entry('a.ts')] });
    server.files['a.ts'] = editedAt('a.ts', 42);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const through = vi.fn((url: string, init?: RequestInit) =>
      url.includes('/scm/comments')
        ? gate.then(() => server.fetch(url, init))
        : server.fetch(url, init),
    );
    vi.stubGlobal('fetch', through);
    commentsStore.setActiveRepo(REPO);
    commentsStore.setDraft(
      REPO,
      { path: 'a.ts', side: 'new', start: 42, end: 42, commentId: 's42', scope: 'changes' },
      'typed before the remount',
    );
    mountReview();
    await screen.findByTestId('review-list');
    await settle();
    expect(screen.queryByTestId('review-comment-editor')).toBeNull();

    release();
    await settle();
    const editor = screen.getByTestId('review-comment-editor');
    expect(editor).not.toHaveAttribute('data-orphaned');
    expect(input().value).toBe('typed before the remount');
  });

  it('an ordinary edit is not an orphan', async () => {
    server.comments = [stored(42, 42)];
    server.rev = 1;
    await open();
    fireEvent.click(screen.getByTestId('review-comment-edit'));
    expect(screen.getByTestId('review-comment-editor')).not.toHaveAttribute('data-orphaned');
    expect(screen.queryByTestId('review-comment-orphaned')).toBeNull();
  });
});

// ── Where focus goes when a comment ends ─────────────────────────────────────

describe('the soft keyboard after a comment', () => {
  let kbd: HTMLTextAreaElement;
  beforeEach(() => {
    kbd = document.createElement('textarea');
    kbd.id = 'mobile-kbd';
    document.body.append(kbd);
  });
  afterEach(() => kbd.remove());

  const compose = async (held: boolean) => {
    await open();
    click(newNumber(42));
    if (held) kbd.focus();
    chooseComment();
    expect(input()).toHaveFocus(); // the textarea takes focus either way
    type('a note');
  };

  it('goes back to #mobile-kbd on save, when it held focus before the comment', async () => {
    await compose(true);
    await save();
    expect(kbd).toHaveFocus();
  });

  it('goes back on cancel', async () => {
    await compose(true);
    fireEvent.click(screen.getByTestId('review-comment-cancel'));
    expect(kbd).toHaveFocus();
  });

  it('goes back on Escape', async () => {
    await compose(true);
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(kbd).toHaveFocus();
  });

  it('is not raised when it did not hold focus before: no keyboard comes from nowhere', async () => {
    await compose(false);
    await save();
    expect(kbd).not.toHaveFocus();
    expect(document.activeElement).not.toBe(kbd);
  });

  it('is not raised by cancelling a draft that began without it', async () => {
    await compose(false);
    fireEvent.click(screen.getByTestId('review-comment-cancel'));
    expect(kbd).not.toHaveFocus();
  });

  it('stays out of the way of a refused save: the text keeps focus until it is saved', async () => {
    await compose(true);
    server.commentRefusals.push({ status: 400, body: { error: 'body is too long' } });
    await save();
    expect(screen.getByTestId('review-comment-error')).toBeInTheDocument();
    expect(kbd).not.toHaveFocus();
    await save();
    expect(kbd).toHaveFocus();
  });

  it('remembers across a scroll that unmounted the editor', async () => {
    const long = snapshot('a.ts', {
      old: { id: 'o', text: `${lines(400).join('\n')}\n` },
      new: { id: 'n', text: `${lines(400).join('\n')}\n` },
      hunks: [hunk(lines(400).map((text): ['ctx', string] => ['ctx', text]))],
    });
    server.status[REPO] = statusBody({ changes: [entry('a.ts')] });
    server.files['a.ts'] = long;
    mountReview();
    await screen.findByTestId('review-list');
    await settle();
    click(newNumber(3));
    kbd.focus();
    chooseComment();
    type('kept across a scroll');
    scrollTo(6000);
    await settle();
    expect(screen.queryByTestId('review-comment-input')).toBeNull();
    scrollTo(0);
    await settle();
    await save();
    expect(kbd).toHaveFocus();
  });
});
