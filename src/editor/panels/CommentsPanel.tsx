import { useState } from 'react';
import { Check, CheckCheck, MessageSquareText, Undo2 } from 'lucide-react';
import { listReview, reviewCounts } from '@/core/review';
import { useProject } from '@/store/doc';
import { goToComment, resolveAllComments, setCommentResolved } from '@/store/commentActions';
import { pickReviewFile } from '@/store/reviewActions';
import { IconButton } from '../ui/controls';

/** The Comments window: the notes a reviewer left through the player page (File → Import reviewer comments), all in one list. A click goes to the moment. */
export function CommentsPanel() {
  const doc = useProject().skeleton;
  const [showResolved, setShowResolved] = useState(true);
  const counts = reviewCounts(doc);
  const items = listReview(doc, true).filter((i) => showResolved || !i.marker.resolved);
  return (
    <div className="panel grow" style={{ minHeight: 110 }}>
      <div className="panel-head">
        <span className="title">Comments</span>
        <span className="chip" title="Open and resolved comments">{`${counts.open} open · ${counts.resolved} resolved`}</span>
        <IconButton icon={MessageSquareText} title="Import the comments a reviewer sent back" small onClick={() => pickReviewFile()} />
        <IconButton
          icon={CheckCheck}
          title="Mark every open comment resolved"
          small
          disabled={!counts.open}
          onClick={() => resolveAllComments()}
        />
      </div>
      <div className="panel-body">
        <label className="row" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          <span className="label">Show resolved</span>
        </label>
        {items.length === 0 && (
          <p className="hint-text" style={{ padding: '4px 12px' }}>
            {counts.open + counts.resolved === 0
              ? 'No comments yet. Send the player page to a reviewer (Export → Player page) and import the file they send back.'
              : 'Nothing open.'}
          </p>
        )}
        {items.map(({ animationId, animation, marker }) => (
          <div
            key={marker.id}
            className={`row${marker.resolved ? ' dim' : ''}`}
            onClick={() => goToComment(animationId, marker.id)}
            title={marker.text}
          >
            <span className="label">
              <b>{`${animation} ${marker.time.toFixed(2)} s`}</b>
              {marker.bone ? ` [${marker.bone}]` : ''}
              {marker.author ? ` ${marker.author}:` : ''} {marker.text}
            </span>
            <span className="actions pinned">
              <IconButton
                icon={marker.resolved ? Undo2 : Check}
                title={marker.resolved ? 'Open this comment again' : 'Mark this comment resolved'}
                small
                onClick={(e) => (e.stopPropagation(), setCommentResolved(animationId, marker.id, !marker.resolved))}
              />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
