// ── The editor of a comment: a new one, or an edit of a stored one ────────────
//
// A real `<textarea>`: the soft keyboard, IME composition and the browser's own
// editing all work as they do anywhere. Its text lives in the comments store, not
// here, because the review is virtualised: this row unmounts when it scrolls away,
// and the draft must be there, unsaved and intact, when it comes back. Escape
// cancels (and drops the draft); Save keeps the draft until the server has answered,
// and a refusal is shown here, under the text that was refused.
//
// An ORPHANED edit is the one whose comment another window deleted while it was
// open. The text is all that is left of it, so it is neither dropped nor saved into
// a comment that no longer exists: the editor says so, quotes the code the comment
// was about, and offers Save as new or Discard.
//
// Focus: a draft the person just opened takes it (`takeFocus`), and the pane puts
// the soft keyboard back when the draft ends (see `closeDraft` in ReviewPane).

import { useState, type KeyboardEvent } from 'react';
import { pressMove } from '../panes/press';
import { Button } from '../ui';
import type { CommentActions } from './comment-actions';
import type { DraftTarget } from './comments-store';
import { QUOTE_MAX_LINES } from './review-metrics';

export interface CommentEditorProps {
  target: DraftTarget;
  actions: CommentActions;
  /** The comment this edits no longer exists. */
  orphaned?: boolean;
}

export const CommentEditor = ({ target, actions, orphaned = false }: CommentEditorProps) => {
  const [text, setText] = useState(() => actions.draftText(target) ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const close = (): void => actions.closeDraft(target);

  const save = async (): Promise<void> => {
    if (saving || actions.readOnly) return;
    setSaving(true);
    setError(null);
    const result = await (orphaned ? actions.saveAsNew(target, text) : actions.save(target, text));
    // On success the draft is closed and this editor is gone; only a refusal stays.
    if (!result.ok) {
      setError(result.message);
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const quote = orphaned ? target.quote?.lines.slice(0, QUOTE_MAX_LINES) : undefined;

  return (
    <div
      className="rv-card rv-editor"
      data-testid="review-comment-editor"
      data-orphaned={orphaned ? 'true' : undefined}
    >
      {orphaned && (
        <div className="rv-card-note" role="status" data-testid="review-comment-orphaned">
          This comment was deleted in another window. Your text is kept: save it as a new comment,
          or discard it.
        </div>
      )}
      {quote !== undefined && quote.length > 0 && (
        <pre className="rv-quote" data-testid="review-comment-quote">
          {quote.join('\n')}
          {(target.quote?.lines.length ?? 0) > quote.length ? '\n…' : ''}
        </pre>
      )}
      <textarea
        className="rv-input"
        rows={3}
        value={text}
        placeholder="Leave a comment"
        aria-label={target.commentId === undefined ? 'New comment' : 'Edit comment'}
        data-testid="review-comment-input"
        spellCheck
        disabled={saving || actions.readOnly}
        ref={(el) => {
          if (el && actions.takeFocus(target)) el.focus();
        }}
        onChange={(e) => {
          setText(e.target.value);
          actions.setDraft(target, e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      {error !== null && (
        <div className="rv-card-error" role="alert" data-testid="review-comment-error">
          {error}
        </div>
      )}
      <div className="rv-card-actions">
        <Button
          size="sm"
          variant="primary"
          disabled={saving || actions.readOnly}
          data-testid={orphaned ? 'review-comment-save-new' : 'review-comment-save'}
          {...pressMove(() => void save())}
        >
          {saving ? 'Saving…' : orphaned ? 'Save as new' : 'Save'}
        </Button>
        <Button
          size="sm"
          disabled={saving}
          data-testid={orphaned ? 'review-comment-discard' : 'review-comment-cancel'}
          {...pressMove(close)}
        >
          {orphaned ? 'Discard' : 'Cancel'}
        </Button>
      </div>
    </div>
  );
};
