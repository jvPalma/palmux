// ── Copy comments: the document, read through this window ─────────────────────
//
// The document and its outdated marks are `@palmux/shared`'s (`commentsMarkdown`),
// the one exporter the Source Control view, a review's copy buttons and
// `palmux comments` all print. This side only says how a browser reads a snapshot
// (`fetchScmFile`) and how the text reaches the clipboard inside the tap.

import {
  commentsMarkdown as sharedCommentsMarkdown,
  type ScmComment,
  type ScmStatus,
} from '@palmux/shared';
import { copyText } from '../mobile/clipboard';
import { fetchScmFile } from '../review/review-api';

/**
 * Every comment of `repo` as one markdown document, outdated and not-shown ones
 * marked; with `path`, that file's comments alone (a review's file-header copy).
 */
export function commentsMarkdown(
  repo: string,
  status: ScmStatus | null,
  comments: readonly ScmComment[],
  path?: string,
): Promise<string> {
  const mine = path === undefined ? comments : comments.filter((c) => c.path === path);
  return sharedCommentsMarkdown(repo, status, mine, fetchScmFile);
}

/**
 * Puts `text` on the clipboard while it is still being computed. The document needs
 * a read per commented file, and a clipboard write is honoured only inside the tap:
 * WebKit refuses one that follows an awaited fetch, and Firefox one that outlasts its
 * activation window. A `ClipboardItem` takes a PROMISE, so the write is asked for
 * inside the gesture and the browser waits for the text. Where that is missing or
 * refused, the finished text goes through `copyText`, which Chromium still accepts.
 */
export async function copyPendingText(text: Promise<string>): Promise<boolean> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return true;
    } catch {
      // fall through to the copy that waits for the text
    }
  }
  return copyText(await text);
}

/** `1 comment`, `3 comments`: the count the copy toast and the Clear all confirm name. */
export function commentCount(n: number): string {
  return `${n} ${n === 1 ? 'comment' : 'comments'}`;
}

/** Ask once before Clear all, naming how many comments go and in which project (D9). */
export function confirmClearAll(n: number, top: string): boolean {
  const name = top.split('/').filter(Boolean).pop() ?? top;
  return window.confirm(`Delete all ${commentCount(n)} in ${name}? This cannot be undone.`);
}
