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
    // `input` is NOT in this list, and that is deliberate. GFM renders a task
    // list (`- [ ]`) as `<input type="checkbox" disabled>`, so forbidding the
    // tag silently deleted every checkbox and left bare bullets — measured: 0
    // `input[type=checkbox]` in the rendered DOM. The hook below narrows the
    // exception to exactly that shape, which is what the denylist was protecting
    // against: a live form control inside rendered markdown.
    FORBID_TAGS: ['style', 'form', 'button', 'select', 'textarea'],
    ADD_ATTR: ['target'],
  });

  const tpl = document.createElement('template');
  tpl.innerHTML = clean;

  // Allowing `input` back costs nothing only if it stays a task-list checkbox.
  // Anything else — a text field, an enabled checkbox, one carrying a name or a
  // value — is removed here rather than trusted, so a hostile document cannot
  // put a real control in the reader's way.
  for (const el of tpl.content.querySelectorAll('input')) {
    const ok = el.getAttribute('type') === 'checkbox';
    if (!ok) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      if (attr.name !== 'type' && attr.name !== 'checked' && attr.name !== 'disabled') {
        el.removeAttribute(attr.name);
      }
    }
    el.setAttribute('disabled', ''); // a rendered document is never interactive
  }

  // A task item's text must be ONE grid item. Bare text runs beside the input
  // become separate anonymous grid items, and each claims its own track: the
  // auto column widens to the longest plain-text line and squeezes the 1fr
  // column down to the <strong>'s longest word — measured as a one-word-per-
  // line column beside a full-width paragraph. Wrap everything after the
  // checkbox in one block instead, so the grid is [checkbox][one block].
  for (const li of tpl.content.querySelectorAll('li')) {
    const input = li.querySelector(':scope > input[type="checkbox"]');
    if (!input) continue;
    const text = document.createElement('div');
    text.className = 'md-task-text';
    let node = input.nextSibling;
    while (node) {
      const next = node.nextSibling;
      text.appendChild(node);
      node = next;
    }
    li.appendChild(text);
  }

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
