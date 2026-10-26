// ── The window's comments store, and the hook that reads it ───────────────────
//
// `createCommentsStore` is framework-free and takes its four requests as options;
// this is where the real ones are bound, once per window, the way
// `scmStatusStore` binds the status request. Everything that reads comments goes
// through `useComments(repo, visible)`, which counts as a subscriber only while it
// is visible and `repo` is the device's active project.
//
// Two things reach the store from elsewhere: `scmComments` frames (App's control
// socket) and the `commentsRev` that rides on every status answer.
// `connectCommentsToStatus` is the second: the status store never imports the
// comments store, and the comments store never polls, so something has to tell it
// that a newer rev was heard of.

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  createScmComment,
  deleteScmComment,
  fetchScmComments,
  updateScmComment,
} from '../scm/scm-api';
import type { ScmStatusStore } from '../scm/status-store';
import {
  createCommentsStore,
  type CommentsSnapshot,
  type CommentsStore,
  type CommentsSubscription,
} from './comments-store';

/** The window's one store. */
export const commentsStore: CommentsStore = createCommentsStore({
  list: (repo) => fetchScmComments(repo),
  create: createScmComment,
  update: updateScmComment,
  remove: deleteScmComment,
});

/**
 * Tell `comments` the rev of every status answer. A status read repeats the same
 * rev every second, which the store ignores; a newer one makes a visible window
 * read the list. Returns the way to stop.
 */
export function connectCommentsToStatus(
  status: ScmStatusStore,
  comments: CommentsStore,
): () => void {
  const hear = (): void => {
    const state = status.getState();
    if (state.repo !== '' && state.status !== null) {
      comments.observeRev(state.repo, state.commentsRev);
    }
  };
  hear();
  return status.subscribe(hear);
}

const emptySnapshot = (repo: string): CommentsSnapshot => ({
  repo,
  loaded: false,
  rev: 0,
  comments: [],
  error: null,
  drafts: [],
});

export interface CommentsResult extends CommentsSnapshot {
  /** `repo` is the device's active project, the only one the store holds. */
  active: boolean;
}

/**
 * The comments of `repo`, and the subscription that keeps them fresh. A `repo`
 * that is not the active project gets an empty state with `active: false` and
 * costs nothing.
 */
export function useComments(repo: string, visible: boolean): CommentsResult {
  const snapshot = useSyncExternalStore(
    commentsStore.subscribe,
    commentsStore.getSnapshot,
    commentsStore.getSnapshot,
  );
  const subscription = useRef<CommentsSubscription | null>(null);
  useEffect(() => {
    const joined = commentsStore.register();
    subscription.current = joined;
    return () => {
      subscription.current = null;
      joined.release();
    };
  }, []);
  // Declared after the registering effect, so on mount it runs against it.
  useEffect(() => {
    subscription.current?.set(repo, visible);
  }, [repo, visible]);
  return useMemo(
    () =>
      snapshot.repo === repo && repo !== ''
        ? { ...snapshot, active: true }
        : { ...emptySnapshot(repo), active: false },
    [snapshot, repo],
  );
}
