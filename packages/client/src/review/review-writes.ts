// ── Reviewed, Unstage and Undo: what a tap does, and what each refusal means ──
//
// The only writes a review makes are three index transactions, and each can be
// refused for a reason the reader has to be able to act on. The requests are
// injected so this stays free of React and the network: the pane gives it the
// real ones, a test gives it promises.
//
// One side effect lives here on purpose: `undoWrites` takes each discard it
// restores out of the project bar's "Undo last discard" (`discard-log.ts`, local
// storage). The review and the Source Control list share the window's one toast
// and its write log, so the review's Undo can restore a discard the list made, and
// the review knows nothing of the project bar. Both Undos run through this path.
//
// Reviewed stages exactly the version the review SHOWED. That is the snapshot's
// `token`, held server-side for ten minutes, so a review left open on a phone can
// outlive it. An expired token (410) is therefore not an error to show: the file is
// fetched again, and when it is the same version (`version` is its identity, and
// independent of the algorithm) the stage is retried ONCE with the new token and the
// reader never knows. When it is another version the reader is told, and nothing is
// staged, because the newer change must be seen before it is called reviewed.

import {
  SCM_SKIP_LABEL,
  type ScmEntry,
  type ScmFileSnapshot,
  type ScmSkip,
  type ScmWriteResult,
} from '@palmux/shared';
import { forgetDiscard } from '../scm/discard-log';
import type { ScmFetchResult } from '../scm/scm-api';
import type { DraftTarget } from './comments-store';
import type { LoggedWrite } from './write-log';

type Answer = Promise<ScmFetchResult<ScmWriteResult>>;
type Failure = Extract<ScmFetchResult<unknown>, { ok: false }>;

export interface WriteDeps {
  stage: (path: string, token: string) => Answer;
  unstage: (path: string, oldPath?: string) => Answer;
  /** Fetch the file again now, landing it in the review; null when it could not be read. */
  reload: (path: string) => Promise<ScmFileSnapshot | null>;
}

export type WriteOutcome =
  | { kind: 'done'; receiptId: string }
  | { kind: 'notice'; message: string };

const notice = (message: string): WriteOutcome => ({ kind: 'notice', message });

/**
 * Why Reviewed is unavailable for a file, or null when it is available. A file
 * palmux could not snapshot has no token, cannot be staged from here, and says so:
 * there is no fallback that stages what was not shown.
 */
export function reviewBlocker(
  entry: Pick<ScmEntry, 'kind'> | undefined,
  snapshot: ScmFileSnapshot | undefined,
): string | null {
  if (entry?.kind === 'unmerged')
    return 'This file has conflicts. Resolve them in your editor first.';
  if (!snapshot) return 'This file has not loaded yet. Wait for its diff to appear.';
  if (snapshot.token !== undefined) return null;
  if (snapshot.tooLarge) return 'This file is too large to stage from palmux. Stage it with git.';
  if (snapshot.converted) {
    return 'This file is converted by git (a filter or an encoding). Stage it with git.';
  }
  return 'palmux cannot stage this version of the file. Stage it with git.';
}

/**
 * Why a file cannot be staged or unstaged from the review `scope` while a comment on
 * it is open there, or null. The write takes the file out of this review, and the
 * open editor goes with it: its text stays in the store, but nothing draws it until
 * the file comes back, so the reader would see the comment vanish unsaved.
 */
export function draftBlocker(
  drafts: readonly Pick<DraftTarget, 'path' | 'scope'>[],
  path: string,
  scope: string,
): string | null {
  if (!drafts.some((draft) => draft.path === path && draft.scope === scope)) return null;
  return `Save or cancel the comment on ${path.slice(path.lastIndexOf('/') + 1)} first.`;
}

const DISCARD_CONFLICT = 'The files changed since the discard';

/**
 * What a refused write means to the reader. `discard` covers a discard and the Undo of
 * one, which writes the work tree and not the index, so its conflict is about the files.
 */
export function describeFailure(
  failure: Failure,
  action: 'stage' | 'unstage' | 'undo' | 'discard',
): string {
  switch (failure.code) {
    case 'busy':
      return 'Git is busy with another command in this project (index.lock). Nothing was changed. Try again in a moment.';
    case 'conflict':
      if (action === 'discard') {
        // The server counts how many files it put back before it stopped; keep that.
        return failure.message.startsWith(DISCARD_CONFLICT) ? failure.message : DISCARD_CONFLICT;
      }
      return 'The index changed since; nothing was undone.';
    case 'changed':
      if (action === 'discard')
        return 'The files changed since you confirmed; nothing was discarded.';
      return 'This file changed since you looked at it, so nothing was staged. The newer version is shown.';
    case 'unsupported':
      return `palmux cannot do this here: ${failure.message}`;
    case 'df':
      return `Git refused: ${failure.message}`;
    case 'token':
      if (action === 'discard') return 'This Undo has expired';
      return action === 'undo'
        ? 'Undo is no longer available.'
        : 'This version of the file is no longer held. Reload it and try again.';
    default:
      return failure.message;
  }
}

// A stage or unstage always answers a receipt; only a discard's Undo answers none.
const done = (result: ScmWriteResult): WriteOutcome =>
  result.receiptId === null
    ? notice('The server answered without an Undo receipt.')
    : { kind: 'done', receiptId: result.receiptId };

/** Stage the version `shown` is, with the one transparent retry described above. */
export async function reviewShown(deps: WriteDeps, shown: ScmFileSnapshot): Promise<WriteOutcome> {
  const blocker = reviewBlocker(undefined, shown);
  if (blocker !== null || shown.token === undefined) return notice(blocker ?? 'Not reviewable.');

  let result = await deps.stage(shown.path, shown.token);
  if (!result.ok && result.code === 'token') {
    const fresh = await deps.reload(shown.path);
    if (!fresh) return notice('Could not load this file again, so nothing was staged. Try again.');
    if (fresh.version !== shown.version) {
      return notice(
        describeFailure({ ok: false, message: '', httpStatus: 409, code: 'changed' }, 'stage'),
      );
    }
    if (fresh.token === undefined)
      return notice(reviewBlocker(undefined, fresh) ?? 'Not reviewable.');
    result = await deps.stage(shown.path, fresh.token);
  }
  if (result.ok) return done(result.value);
  // The attribute context moved: the file will be read again by the epoch anyway,
  // but the reader is looking at the old one now.
  if (result.code === 'changed') void deps.reload(shown.path);
  return notice(describeFailure(result, 'stage'));
}

/** Return a staged file (and the source of a rename) to HEAD. */
export async function unstageEntry(
  deps: WriteDeps,
  entry: Pick<ScmEntry, 'path' | 'oldPath'>,
): Promise<WriteOutcome> {
  const result = await deps.unstage(entry.path, entry.oldPath);
  return result.ok ? done(result.value) : notice(describeFailure(result, 'unstage'));
}

const files = (count: number): string => `${count} ${count === 1 ? 'file' : 'files'}`;

/**
 * What a batch left alone, empty with none: one file by name ("skipped link.ts (a
 * symbolic link)"), several with their one reason ("skipped 2 (needs a git filter)"),
 * or with each reason and its count, in the order met ("skipped 3 (needs a git
 * filter: 2, no longer changed: 1)").
 */
function skipSuffix(skipped: readonly ScmSkip[]): string {
  const [first] = skipped;
  if (first === undefined) return '';
  if (skipped.length === 1) {
    const name = first.path.slice(first.path.lastIndexOf('/') + 1);
    return `, skipped ${name} (${SCM_SKIP_LABEL[first.reason]})`;
  }
  const counts = new Map<ScmSkip['reason'], number>();
  for (const skip of skipped) counts.set(skip.reason, (counts.get(skip.reason) ?? 0) + 1);
  const reasons =
    counts.size === 1
      ? SCM_SKIP_LABEL[first.reason]
      : [...counts].map(([reason, count]) => `${SCM_SKIP_LABEL[reason]}: ${count}`).join(', ');
  return `, skipped ${skipped.length} (${reasons})`;
}

/** What the toast says of a batch that changed nothing, so it carries no Undo (R1). */
export function describeNoChange(
  action: 'stage' | 'unstage' | 'discard',
  skipped: readonly ScmSkip[],
): string {
  const word = action === 'stage' ? 'staged' : action === 'unstage' ? 'unstaged' : 'discarded';
  return `Nothing ${word}${skipSuffix(skipped)}`;
}

const PAST = { stage: 'Staged', unstage: 'Unstaged', discard: 'Discarded' } as const;
const ORDER = ['stage', 'unstage', 'discard'] as const;

/**
 * What the toast says of the writes it offers to undo: one write by name ("Reviewed
 * a.ts", "Staged a.ts" from the list), a write of many files or several writes by
 * count ("Staged 40 files", "Staged 2 files, unstaged 1 file"), and the paths they
 * left alone at the end ("Staged 38 files, skipped 2 (needs a git filter)").
 */
export function describeWrites(writes: readonly LoggedWrite[]): string {
  const skips = writes.flatMap((write) => write.skipped ?? []);
  const [only] = writes;
  if (only !== undefined && writes.length === 1 && (only.count ?? 1) <= 1) {
    const verb = only.action === 'stage' && only.via === undefined ? 'Reviewed' : PAST[only.action];
    return `${verb} ${only.name}${skipSuffix(skips)}`;
  }
  const parts: string[] = [];
  for (const action of ORDER) {
    const count = writes
      .filter((write) => write.action === action)
      .reduce((sum, write) => sum + (write.count ?? 1), 0);
    if (count === 0) continue;
    const verb = parts.length === 0 ? PAST[action] : PAST[action].toLowerCase();
    parts.push(`${verb} ${files(count)}`);
  }
  return parts.join(', ') + skipSuffix(skips);
}

export type UndoOutcome =
  | { kind: 'done'; undone: number }
  | { kind: 'notice'; message: string; undone: number };

/**
 * Put index entries back exactly as they were, newest write first. Each is a
 * compare-and-swap on its own receipt, so a write that something else has touched
 * since is refused (409) and the undo STOPS there: what came before it stays as it
 * is, and the reader is told how far it got. Undoing out of order would restore an
 * older entry over a newer one.
 */
export async function undoWrites(
  restore: (repo: string, receiptId: string) => Answer,
  writes: readonly LoggedWrite[],
): Promise<UndoOutcome> {
  let undone = 0;
  for (const write of writes.toReversed()) {
    // oxlint-disable-next-line no-await-in-loop -- newest first, and each needs the one before it undone
    const result = await restore(write.repo, write.receiptId);
    if (!result.ok) {
      const discard = write.action === 'discard';
      // An expired discard receipt can never be restored: the project bar must stop offering it.
      if (discard && result.code === 'token') forgetDiscard(write.repo, write.receiptId);
      const reason = discard
        ? describeFailure(result, 'discard')
        : undone > 0 && result.code === 'conflict'
          ? 'The index changed since for the rest, so they were left as they are.'
          : describeFailure(result, 'undo');
      const message = undone > 0 ? `Undid ${undone} of ${writes.length}. ${reason}` : reason;
      return { kind: 'notice', message, undone };
    }
    // The receipt is spent: the project bar must not offer it again (see the header).
    if (write.action === 'discard') forgetDiscard(write.repo, write.receiptId);
    undone += 1;
  }
  return { kind: 'done', undone };
}
