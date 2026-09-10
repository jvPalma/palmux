// ── Session id allocation ─────────────────────────────────────────────────────
//
// Shared by the client (+ button) and the server (GET /new) so both pick the
// same "next" workspace: the lowest non-negative integer id not currently live.

/** Lowest non-negative integer whose String() is not already in `ids`. */
export function nextFreeId(ids: string[]): string {
  const taken = new Set(ids);
  let n = 0;
  while (taken.has(String(n))) n += 1;
  return String(n);
}

// A canonical workspace/tab id: 0, or 1-9999 with NO leading zeros — exactly the
// shape nextFreeId emits. Rejecting "01" (distinct from "1") and >9999 keeps the
// id space single-valued so the WS route, the store, and the pane-file path all
// agree on what a valid id is.
const TAB_ID_RE = /^(?:0|[1-9]\d{0,3})$/;

export function isTabId(v: unknown): v is string {
  return typeof v === 'string' && TAB_ID_RE.test(v);
}

// A tab GROUP id: 'g' followed by 5–12 lowercase-alnum chars. Deliberately
// shape-distinct from a tab id (which is a bare number) so the two id spaces can
// never collide in a `reorderTabs`/`groupUpdate` payload or the tabs.json store.
// The server mints these (crypto-random); both sides validate with isGroupId.
const GROUP_ID_RE = /^g[0-9a-z]{5,12}$/;

export function isGroupId(v: unknown): v is string {
  return typeof v === 'string' && GROUP_ID_RE.test(v);
}
