// ── Copy comments: the markdown a person or an agent reads ────────────────────
//
// One document for the whole project (or for one file of it): a short instruction
// naming the project, then a section per file in path order, and under it each
// comment headed `path:Lstart-Lend (side)`, the code it covers as a fenced block and
// its text. The heading carries the path as well as the section does, so an agent
// that reads one heading alone still knows where to go. A comment is quoted as it was
// STORED (its own lines and range) because the export covers files nobody has open,
// and the quote is what lets a reader find the code when the range has moved.
// `outdated` is told in, not found here: only a look at the file can say
// (`comment-marks.ts`). The Source Control view, a review's copy buttons and
// `palmux comments` all print this one function's output.

import type { ScmComment } from './scm-comments';
import { languageOf } from './editor-language';
import { UNREAD_REASON } from './comment-placement';

export interface ExportOptions {
  /** Ids of the comments whose code is no longer in the file. */
  outdated?: ReadonlySet<string>;
  /** Ids of the comments on a file palmux did not read (too large, converted). */
  unread?: ReadonlySet<string>;
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Document order within a file: by range, the old side before the new one, then as created. */
function byPosition(a: ScmComment, b: ScmComment): number {
  if (a.start !== b.start) return a.start - b.start;
  if (a.end !== b.end) return a.end - b.end;
  if (a.side !== b.side) return a.side === 'old' ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return byPath(a.id, b.id);
}

/** A fence one backtick longer than any run in the code, so quoted code can never close it. */
function fenceFor(lines: readonly string[]): string {
  let longest = 0;
  for (const line of lines) {
    for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/** What follows a comment's side when the comment cannot be found in its file: why not. */
function markOf(comment: ScmComment, options: ExportOptions): string {
  if (options.outdated?.has(comment.id)) return ' (outdated)';
  // Not "outdated": palmux never read this file, so nothing says the code left.
  if (options.unread?.has(comment.id)) return ` (not shown: ${UNREAD_REASON})`;
  return '';
}

function renderComment(comment: ScmComment, mark: string): string {
  const range =
    comment.start === comment.end ? `L${comment.start}` : `L${comment.start}-L${comment.end}`;
  const parts = [`### ${comment.path}:${range} (${comment.side})${mark}`];
  if (comment.lines.length > 0) {
    const fence = fenceFor(comment.lines);
    // A plaintext file gets a bare fence: naming `plaintext` would only add noise.
    const language = languageOf(comment.path);
    const info = language === 'plaintext' ? '' : language;
    parts.push(`${fence}${info}\n${comment.lines.join('\n')}\n${fence}`);
  }
  const body = comment.body.trimEnd();
  if (body !== '') parts.push(body);
  return parts.join('\n\n');
}

/** What the document opens with: what to do, and how to read a heading. */
function preamble(top: string): string {
  return [
    '# Review comments',
    `Address each review comment below in ${top}. A heading names the file, the line range and the side\n(old = before the change, new = after it); the fenced block is the code the comment was written on.`,
  ].join('\n\n');
}

/** Every comment of the project `top` as one markdown document; empty when there are none. */
export function exportCommentsMarkdown(
  top: string,
  comments: readonly ScmComment[],
  options: ExportOptions = {},
): string {
  const files = new Map<string, ScmComment[]>();
  for (const comment of comments) {
    const group = files.get(comment.path);
    if (group) group.push(comment);
    else files.set(comment.path, [comment]);
  }
  const sections = [...files.keys()].toSorted(byPath).map((path) => {
    const rendered = (files.get(path) ?? [])
      .toSorted(byPosition)
      .map((comment) => renderComment(comment, markOf(comment, options)));
    return [`## ${path}`, ...rendered].join('\n\n');
  });
  return sections.length === 0 ? '' : `${[preamble(top), ...sections].join('\n\n')}\n`;
}

/** The same document for one file's comments alone: the copy on a review's file header. */
export function exportFileCommentsMarkdown(
  top: string,
  path: string,
  comments: readonly ScmComment[],
  options: ExportOptions = {},
): string {
  return exportCommentsMarkdown(
    top,
    comments.filter((comment) => comment.path === path),
    options,
  );
}
