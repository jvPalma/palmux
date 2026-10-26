// ── One stored comment, as a card ─────────────────────────────────────────────
//
// Under the last line of its range, with its range and side, or in the list at the
// end of a file when it has no line to hang from (then the code it was about is
// quoted, since the quote is all that is left to find it by). Edit and Delete are
// in a scroller, so they act on release inside the slop (`pressMove`).

import type { ScmComment } from '@palmux/shared';
import { pressMove } from '../panes/press';
import { IconButton } from '../ui';
import { Icon } from '../ui/icons';
import type { CommentActions } from './comment-actions';
import type { UnplacedItem } from './rows';
import { UNREAD_REASON } from './comment-placement';
import { QUOTE_MAX_LINES } from './review-metrics';

export interface CommentCardProps {
  comment: ScmComment;
  /** Where the card is drawn: the range and side it is found on in this review. */
  side: 'old' | 'new';
  start: number;
  end: number;
  /** Set for a comment drawn in the list: why it is not under a line. */
  unplaced?: UnplacedItem['reason'];
  actions: CommentActions;
}

const REASON: Record<UnplacedItem['reason'], string> = {
  outdated: 'Outdated',
  hidden: 'In a hidden part of the file',
  // Not "outdated": palmux never read this file, so nothing says its code left.
  unread: `Not shown (${UNREAD_REASON})`,
};

export const CommentCard = ({ comment, side, start, end, unplaced, actions }: CommentCardProps) => {
  const range = start === end ? `L${start}` : `L${start}–${end}`;
  const shown = comment.lines.slice(0, QUOTE_MAX_LINES);
  return (
    <div
      className="rv-card"
      data-testid="review-comment"
      data-comment-id={comment.id}
      data-unplaced={unplaced}
    >
      <div className="rv-card-head">
        <Icon name="comment" size={14} />
        <span className="rv-card-range" data-testid="review-comment-range">
          {range} · {side}
        </span>
        {unplaced && (
          <span className="rv-card-flag" data-testid="review-comment-flag">
            {REASON[unplaced]}
          </span>
        )}
        <span className="rv-fill" />
        <IconButton
          label="Edit comment"
          size="sm"
          disabled={actions.readOnly}
          data-testid="review-comment-edit"
          {...pressMove(() => actions.edit(comment))}
        >
          <Icon name="pencil" size={14} />
        </IconButton>
        <IconButton
          label="Delete comment"
          size="sm"
          disabled={actions.readOnly}
          data-testid="review-comment-delete"
          {...pressMove(() => actions.remove(comment))}
        >
          <Icon name="close" size={14} />
        </IconButton>
      </div>
      {unplaced && shown.length > 0 && (
        <pre className="rv-quote" data-testid="review-comment-quote">
          {shown.join('\n')}
          {comment.lines.length > shown.length ? '\n…' : ''}
        </pre>
      )}
      <div className="rv-card-body" data-testid="review-comment-body">
        {comment.body}
      </div>
    </div>
  );
};
