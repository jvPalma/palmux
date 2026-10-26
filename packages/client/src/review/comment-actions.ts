// ── What a comment on screen can do ───────────────────────────────────────────
//
// The comment cards and editors live inside virtualised rows and know nothing of
// the store, the project or the file's text. The pane builds this once and hands it
// down through the row props, which is also what makes a paused review read-only
// in one place instead of in every button.

import type { ScmComment } from '@palmux/shared';
import type { CommentWriteResult, DraftTarget } from './comments-store';

export interface CommentActions {
  /** The project is not the one this device reads (or is removed): nothing here can be written. */
  readOnly: boolean;
  draftText: (target: DraftTarget) => string | undefined;
  setDraft: (target: DraftTarget, text: string) => void;
  /** Close a draft without saving it. */
  closeDraft: (target: DraftTarget) => void;
  /** Save a draft: a new comment, or the edit of the stored one it names. Closes the draft on success. */
  save: (target: DraftTarget, body: string) => Promise<CommentWriteResult>;
  /** Save an edit whose comment no longer exists as a new comment on the code it was stored with. */
  saveAsNew: (target: DraftTarget, body: string) => Promise<CommentWriteResult>;
  /** Open the editor on a stored comment. */
  edit: (comment: ScmComment) => void;
  /** Delete a stored comment; one confirmation, and only when it has text. */
  remove: (comment: ScmComment) => void;
  /**
   * True once, for the editor of a draft a person has just opened: it takes focus.
   * An editor that mounts again because it scrolled back into view must not.
   */
  takeFocus: (target: DraftTarget) => boolean;
}
