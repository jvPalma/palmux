// ── Markdown renderer ─────────────────────────────────────────────────────────
//
// The ONLY module that imports marked/dompurify — MarkdownPane pulls it in via
// dynamic import(), so vite splits both into a lazy chunk (a terminal-only
// client downloads none of it). Pipeline: marked (GFM) → DOMPurify (a hostile
// file must never script the app) → a DOM walk that rewrites links/images:
//   • relative *.md links  → internal navigation (data-md-path, handled by the
//     pane — the SAME pane renders the target, Chrome-like)
//   • other relative links + images → served through GET /md-file?path=…
//   • absolute http(s) links → target=_blank rel=noopener (never navigate the app)

/**
 * Resolve `rel` against the DIRECTORY of `fromFile` (posix, '..' safe). A
 * leading-'/' `rel` is treated as an ABSOLUTE path (resolved from root, not
 * grafted under the current dir).
 */
export function resolveRelative(fromFile: string, rel: string): string {
  const baseDir = fromFile.split('/').slice(0, -1).join('/');
  const combined = rel.startsWith('/') ? rel : `${baseDir}/${rel}`;
  const out: string[] = [];
  for (const part of combined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

/** marked percent-encodes link/image targets; decode once so paths reach the
 *  server as real filenames (café.png, "my notes.md") instead of double-encoded
 *  404s. Malformed sequences pass through untouched. */
function decodeTarget(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const isExternal = (href: string): boolean => /^https?:\/\//i.test(href);
const isAnchor = (href: string): boolean => href.startsWith('#');
const isMd = (p: string): boolean => /\.(md|markdown|mdx)$/i.test(p.split('#')[0] ?? '');

export const MD_FILE_URL = (path: string): string => `/md-file?path=${encodeURIComponent(path)}`;

/**
 * Render markdown to sanitized, link-rewritten HTML. `currentPath` anchors
 * relative resolution (undefined → relative links render inert).
 */
export async function renderMarkdown(text: string, currentPath?: string): Promise<string> {
  const [{ marked }, { default: DOMPurify }] = await Promise.all([
    import('marked'),
    import('dompurify'),
  ]);

  const raw = marked.parse(text, { gfm: true, async: false });
  const clean = DOMPurify.sanitize(raw, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea'],
    ADD_ATTR: ['target'],
  });

  const tpl = document.createElement('template');
  tpl.innerHTML = clean;

  for (const a of tpl.content.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (isAnchor(href)) continue;
    if (isExternal(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      continue;
    }
    if (!currentPath) {
      a.removeAttribute('href'); // relative with no anchor file — inert
      continue;
    }
    const target = resolveRelative(currentPath, decodeTarget(href.split('#')[0] ?? ''));
    if (isMd(href)) {
      // Internal navigation: a normal left-click opens the target IN THE PANE
      // (the pane's delegate preventDefaults it). href points at the raw file
      // as a meaningful fallback for middle-/ctrl-click — never a bare '#'.
      a.setAttribute('data-md-path', target);
      a.setAttribute('href', MD_FILE_URL(target));
      a.classList.add('md-internal');
    } else {
      a.setAttribute('href', MD_FILE_URL(target));
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }

  for (const img of tpl.content.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src') ?? '';
    if (isExternal(src) || src.startsWith('data:')) continue; // sanitized already
    if (!currentPath) {
      img.removeAttribute('src');
      continue;
    }
    img.setAttribute('src', MD_FILE_URL(resolveRelative(currentPath, decodeTarget(src))));
  }

  return tpl.innerHTML;
}
