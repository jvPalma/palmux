// ── Clipboard write with a legacy fallback ────────────────────────────────────
//
// navigator.clipboard.writeText is the modern path, but it rejects in contexts
// where it isn't allowed — notably some mobile browsers and pages served behind
// a strict Permissions-Policy. When it fails we fall back to the legacy
// execCommand('copy') over a temporary textarea, which works in more places.
// Both paths must run inside a user gesture (a tap), so call this from an event
// handler, not after an await gap.

export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const active = document.activeElement as HTMLElement | null;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS needs an explicit range
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
    active?.focus?.(); // restore focus (e.g. the soft-keyboard textarea)
  }
}
