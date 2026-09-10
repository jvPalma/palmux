// ── The one true tab-order model (shared by server + client) ──────────────────
//
// Both sides need the SAME notion of "what a valid strip order is": the server
// enforces it after every mutation; the client runs it locally so its optimistic
// update matches the broadcast (no flash) instead of re-predicting the server's
// math by hand. Both functions are pure — dependencies come in as callbacks.

/**
 * Stable contiguity partition: each group's members collapse to their FIRST
 * member's slot, relative order preserved; ungrouped tabs stay in place.
 * (docs/group-model.md.)
 */
export function normalizeOrder(
  src: string[],
  groupIdOf: (id: string) => string | undefined,
): string[] {
  const seenGroups = new Set<string>();
  const out: string[] = [];
  for (const id of src) {
    const g = groupIdOf(id);
    if (g === undefined) {
      out.push(id);
      continue;
    }
    if (seenGroups.has(g)) continue;
    seenGroups.add(g);
    for (const m of src) if (groupIdOf(m) === g) out.push(m);
  }
  return out;
}

/**
 * Forgiving permutation: take `desired` (only `known` ids, de-duplicated) then
 * append any `current` ids not placed by `desired` — so a request can never lose
 * or duplicate a tab. Does NOT normalize; callers normalize afterward.
 */
export function forgivingOrder(
  current: string[],
  desired: string[],
  known: (id: string) => boolean,
): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of desired) {
    if (!known(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  for (const id of current) if (!seen.has(id)) next.push(id);
  return next;
}
