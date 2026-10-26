// ── Review comments store ─────────────────────────────────────────────────────
//
// ONE per window, holding the comments of the device's ACTIVE project only, in the
// shape `useSyncExternalStore` wants (`subscribe` + a `getSnapshot` that keeps its
// identity until something changes). It is framework-free: the four requests are
// injected and every one answers a result union, so the tests drive it with
// promises and no network.
//
// The server (design D9) answers EVERY read and write with the whole list and its
// `rev`, so the store never merges. It replaces its state with the answer, and
// that is what makes two windows converge: whatever interleaving the server saw,
// each window ends on the server's last list.
//
//  - A write answer, a refetch and a list from before a project switch can arrive
//    in any order, and an answer whose `rev` is not newer than the applied one
//    carries nothing the window does not already hold, so it is dropped.
//  - Other windows are heard of by an `scmComments` frame (every write, sent
//    independent of the git poll) and by `commentsRev` on each status answer (the
//    backstop for a missed frame). Both reach `observeRev`. A newer rev refetches,
//    but ONLY while a subscriber counts: it is visible and shows the active
//    project. A hidden view costs no request, and catches up when it shows.
//  - The store polls nothing and keeps no timer. After a failed read the next
//    frame or status answer retries, and a retry never loops on its own.
//  - Drafts live here, not in the pane. A review is virtualised, so the editor row
//    of an unsaved comment unmounts when it scrolls away; its text must still be
//    there when it comes back.

import type {
  ScmComment,
  ScmCommentInput,
  ScmCommentList,
  ScmCommentPatch,
  ScmCommentSide,
} from '@palmux/shared';
import type { ScmFetchResult } from '../scm/scm-api';

type Answer = Promise<ScmFetchResult<ScmCommentList>>;

/** The four requests. Each takes the project's top-level path and answers instead of throwing. */
export interface CommentsStoreOptions {
  list: (repo: string) => Answer;
  create: (repo: string, input: ScmCommentInput) => Answer;
  update: (repo: string, id: string, patch: ScmCommentPatch) => Answer;
  remove: (repo: string, id: string) => Answer;
}

/** What a write reports. The new list reaches the caller through the snapshot, not here. */
export type CommentWriteResult = { ok: true } | { ok: false; message: string; httpStatus: number };

/**
 * Which lines a draft is for: the same range on the same side of the same file is
 * one draft. An edit of a stored comment is a draft of its own, so a new comment
 * on the lines of an existing one does not collide with editing that one.
 */
export interface DraftTarget {
  path: string;
  side: ScmCommentSide;
  start: number;
  end: number;
  /** The stored comment this draft edits; absent for a comment not yet saved. */
  commentId?: string;
  /**
   * For an edit: the code the comment was stored with. If the comment is deleted
   * elsewhere while this is open, the text typed here can still be saved as a NEW
   * comment on that code, which nothing else in the window holds any more.
   */
  quote?: { lines: string[]; before: string[]; after: string[] };
  /**
   * Whose draft it is. The store is the window's, and two reviews of one file (its
   * Changes and its Staged) can both show these lines: each takes only the drafts of
   * its own scope, or one unsaved comment would be typed into by two editors at once.
   */
  scope?: string;
}

/** NUL cannot occur in a path (the server refuses it), so it cannot blur two keys together. */
export const draftKey = ({ path, side, start, end, commentId, scope }: DraftTarget): string =>
  `${path}\0${side}\0${start}-${end}\0${commentId ?? ''}\0${scope ?? ''}`;

export interface CommentsSnapshot {
  /** The project this state belongs to: the device's active one, '' for none. */
  repo: string;
  /** False until the first answer for `repo` lands. */
  loaded: boolean;
  /** The applied rev. */
  rev: number;
  comments: readonly ScmComment[];
  /** Why the latest read failed; null once one succeeds. */
  error: string | null;
  /**
   * The open drafts of `repo`, in the order they were opened. This changes when a
   * draft opens or closes, never as one is typed into: read the text with `draftText`.
   */
  drafts: readonly DraftTarget[];
}

export interface CommentsSubscription {
  /** Say which project this subscriber shows and whether it is on screen. */
  set(repo: string, visible: boolean): void;
  release(): void;
}

export interface CommentsStore {
  getSnapshot(): CommentsSnapshot;
  subscribe(listener: () => void): () => void;
  /** The device's active project. Changing it drops the old project's comments, not its drafts. */
  setActiveRepo(repo: string): void;
  /** Join as a subscriber. It counts only while `visible` and on the active project. */
  register(): CommentsSubscription;
  /** An `scmComments` frame or a status answer says `repo`'s comments reached `rev`. */
  observeRev(repo: string, rev: number): void;
  /** Read again whatever the rev says: the control socket reconnected and may have missed frames. */
  refresh(): void;
  add(input: ScmCommentInput): Promise<CommentWriteResult>;
  edit(id: string, patch: ScmCommentPatch): Promise<CommentWriteResult>;
  remove(id: string): Promise<CommentWriteResult>;
  /** Open or update a draft. The target's project is named, so a late keystroke cannot land in another. */
  setDraft(repo: string, target: DraftTarget, text: string): void;
  /** Close a draft (saved, or cancelled). */
  clearDraft(repo: string, target: DraftTarget): void;
  draftText(repo: string, target: DraftTarget): string | undefined;
}

interface Draft {
  target: DraftTarget;
  text: string;
}

const noDrafts: readonly DraftTarget[] = [];

const emptySnapshot = (repo: string, drafts: readonly DraftTarget[]): CommentsSnapshot => ({
  repo,
  loaded: false,
  rev: 0,
  comments: [],
  error: null,
  drafts,
});

export function createCommentsStore(options: CommentsStoreOptions): CommentsStore {
  interface Registration {
    repo: string;
    visible: boolean;
  }
  const registrations = new Set<Registration>();
  const listeners = new Set<() => void>();
  // Per project, then by `draftKey`. Never cleared by a project switch.
  const drafts = new Map<string, Map<string, Draft>>();

  let activeRepo = '';
  let snapshot = emptySnapshot('', noDrafts);
  // The newest rev heard of for the active project, applied or not.
  let knownRev = 0;
  // Counts the observations that raised `knownRev`, so a read can tell whether
  // anything new arrived while it was in flight (and only then reads again).
  let observations = 0;
  // Set by a failed read and by `refresh`: the window must read again whatever the rev says.
  let stale = false;
  // At most one list read at a time. Identity tells a superseded read from the current one.
  let loading: { repo: string; observations: number } | null = null;

  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  const draftsOf = (repo: string): readonly DraftTarget[] => {
    const held = drafts.get(repo);
    return held && held.size > 0 ? [...held.values()].map((draft) => draft.target) : noDrafts;
  };

  const counts = (r: Registration): boolean => r.visible && r.repo !== '' && r.repo === activeRepo;
  const enabled = (): boolean => activeRepo !== '' && [...registrations].some(counts);
  const behind = (): boolean => !snapshot.loaded || stale || knownRev > snapshot.rev;

  /**
   * Replace the state with an authoritative list, unless it is no newer than the
   * one applied or the project is no longer the active one.
   */
  const apply = (repo: string, list: ScmCommentList): void => {
    if (repo !== activeRepo) return;
    knownRev = Math.max(knownRev, list.rev);
    if (snapshot.loaded && list.rev <= snapshot.rev) {
      // Nothing to learn, but an answer at all ends a failure.
      if (snapshot.error !== null) {
        snapshot = { ...snapshot, error: null };
        emit();
      }
      return;
    }
    snapshot = {
      ...snapshot,
      loaded: true,
      rev: list.rev,
      comments: list.comments,
      error: null,
    };
    emit();
  };

  const read = async (): Promise<void> => {
    const mine = { repo: activeRepo, observations };
    loading = mine;
    stale = false;
    const result = await options.list(mine.repo);
    if (loading === mine) loading = null;
    if (mine.repo !== activeRepo) return;
    if (result.ok) {
      apply(mine.repo, result.value);
      // Something newer was heard of (or a refresh asked) while this read was in
      // flight, so it may already be out of date. A read that heard nothing new
      // does not repeat, which is what stops a server that answers older than a
      // frame said from being asked for ever.
      if (observations !== mine.observations || stale) pump();
      return;
    }
    stale = true;
    if (snapshot.error !== result.message) {
      snapshot = { ...snapshot, error: result.message };
      emit();
    }
  };

  /** Start a read if one is wanted, allowed and not already running. */
  function pump(): void {
    if (!enabled() || loading !== null || !behind()) return;
    void read();
  }

  const write = async (run: (repo: string) => Answer): Promise<CommentWriteResult> => {
    const repo = activeRepo;
    if (repo === '') return { ok: false, message: 'No active project', httpStatus: 0 };
    const result = await run(repo);
    if (!result.ok) return { ok: false, message: result.message, httpStatus: result.httpStatus };
    apply(repo, result.value);
    return { ok: true };
  };

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setActiveRepo(repo) {
      if (repo === activeRepo) return;
      activeRepo = repo;
      knownRev = 0;
      stale = false;
      loading = null;
      snapshot = emptySnapshot(repo, draftsOf(repo));
      emit();
      pump();
    },

    register() {
      const registration: Registration = { repo: '', visible: false };
      registrations.add(registration);
      return {
        set(repo, visible) {
          if (registration.repo === repo && registration.visible === visible) return;
          registration.repo = repo;
          registration.visible = visible;
          pump();
        },
        release() {
          if (registrations.delete(registration)) pump();
        },
      };
    },

    observeRev(repo, rev) {
      if (repo !== activeRepo) return;
      const raised = rev > knownRev;
      if (raised) {
        knownRev = rev;
        observations += 1;
      }
      // Only news, or a read still owed, asks for a request: the status answer
      // repeats the same rev every second and must not read each time.
      if (raised || stale || !snapshot.loaded) pump();
    },

    refresh() {
      stale = true;
      pump();
    },

    add: (input) => write((repo) => options.create(repo, input)),
    edit: (id, patch) => write((repo) => options.update(repo, id, patch)),
    remove: (id) => write((repo) => options.remove(repo, id)),

    setDraft(repo, target, text) {
      const key = draftKey(target);
      let held = drafts.get(repo);
      if (!held) {
        held = new Map();
        drafts.set(repo, held);
      }
      const existing = held.get(key);
      if (existing) {
        existing.text = text;
        return;
      }
      held.set(key, { target, text });
      if (repo !== activeRepo) return;
      snapshot = { ...snapshot, drafts: draftsOf(repo) };
      emit();
    },

    clearDraft(repo, target) {
      const held = drafts.get(repo);
      if (!held?.delete(draftKey(target))) return;
      if (held.size === 0) drafts.delete(repo);
      if (repo !== activeRepo) return;
      snapshot = { ...snapshot, drafts: draftsOf(repo) };
      emit();
    },

    draftText: (repo, target) => drafts.get(repo)?.get(draftKey(target))?.text,
  };
}
