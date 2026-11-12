// ── What a review pane takes from the app around it ────────────────────────────
//
// A review lives inside `PaneHost`, which lives inside `GroupsView`, and neither
// carries settings or the project list. Rather than thread six props through two
// components that know nothing about Source Control, App provides this once and
// the pane reads it. PaneHost still passes what only it knows: whether the pane is
// shown, and whether its pane has focus.

import { createContext, useContext } from 'react';
import type { ScmAlgorithm, ScmGroup } from '@palmux/shared';
import type { ClientSettings, ScmLayoutPref } from '../settings/settings';

/** The file a Source Control row asked the review to scroll to. */
export interface ReviewScrollTarget {
  path: string;
  oldPath?: string;
}

/** One action a toast may carry: it then stays up long enough to be read and reached. */
export interface ReviewToastAction {
  label: string;
  onClick: () => void;
}

export type ReviewPreferences = Partial<
  Pick<ClientSettings, 'scmLayout' | 'scmAlgorithm' | 'scmWrap' | 'codeFontSize'>
>;

export interface ReviewHost {
  /** The synced project list: a review of a project that is not in it is a removed one. */
  repos: readonly string[];
  layout: ScmLayoutPref;
  algorithm: ScmAlgorithm;
  /** Null follows the width rule. */
  wrap: boolean | null;
  /** The device's code font size, which the editor shares. Null: never set, so the review's default. */
  codeFontSize: number | null;
  /**
   * Changes each time a file is opened into a review. A mounted pane has no other
   * way to hear that its tab was chosen again for another file.
   */
  openTick: number;
  setPreferences: (change: ReviewPreferences) => void;
  /** Make a project the one this device reads. */
  activate: (repo: string) => void;
  /** Open (or focus) the editor tab for an absolute path. */
  openFile: (path: string) => void;
  /** The pending scroll target for a review's url, handed over once and cleared. */
  takeScrollTarget: (url: string) => ReviewScrollTarget | undefined;
  /** The app's toast. With an action it holds for 6 seconds instead of a moment. */
  notify: (message: string, action?: ReviewToastAction) => void;
  /** Move a single-file review's tab to another file of its group. */
  showFile: (tabId: string, path: string) => void;
  /**
   * Open the continuous review of a group, scrolled to `path` when given, in the project `repo`
   * names (a paused review's own); absent, the project this device reads.
   */
  openReview: (target: { group: ScmGroup; path?: string; repo?: string }) => void;
  /** Keep a preview tab open. */
  pinTab: (tabId: string) => void;
}

export const DEFAULT_REVIEW_HOST: ReviewHost = {
  repos: [],
  layout: 'auto',
  algorithm: 'histogram',
  wrap: null,
  codeFontSize: null,
  openTick: 0,
  setPreferences: () => {},
  activate: () => {},
  openFile: () => {},
  takeScrollTarget: () => undefined,
  notify: () => {},
  showFile: () => {},
  openReview: () => {},
  pinTab: () => {},
};

export const ReviewHostContext = createContext<ReviewHost>(DEFAULT_REVIEW_HOST);

export const useReviewHost = (): ReviewHost => useContext(ReviewHostContext);
