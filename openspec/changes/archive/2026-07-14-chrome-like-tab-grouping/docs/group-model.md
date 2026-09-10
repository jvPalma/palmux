# Group model — data shapes, persistence, normalization

The authoritative TS shapes, id rules, persistence layout, and the `normalizeOrder`
algorithm. Referenced by spec Requirements 1–2 and tasks 1.x / 2.x.

## Wire + in-memory shapes (`shared/protocol.ts`)

```ts
export interface TabGroup {
  id: string;        // isGroupId — 'g' + base36, e.g. 'g3f9k2'
  name?: string;     // optional label; chip shows a colored dot when absent
  color: string;     // palette NAME (a TAB_COLORS name); always present after create
}

// TabMeta gains one optional field (additive — old clients ignore it):
export interface TabMeta {
  id: string; kind: TabKind; name?: string; color?: string; url?: string; title?: string;
  groupId?: string;  // isGroupId; absent = ungrouped
}

// SessionsMessage gains `groups`, strip-ordered (position = its first member's position):
export interface SessionsMessage {
  type: 'sessions'; ids: string[]; titles: {…}; tabs: TabMeta[];
  groups: TabGroup[];   // NEW; [] on an old server (parse default)
}

// Client → server (two messages):
export interface GroupCreateMessage { type: 'groupCreate'; ids: string[]; name?: string; color?: string; }
export interface GroupUpdateMessage {
  type: 'groupUpdate'; id: string;
  name?: string; color?: string;
  addIds?: string[]; removeIds?: string[];
  dissolve?: boolean;
  order?: string[];   // full desired strip id-order (join/leave drops send this)
}
```

**Group color/name and per-tab color/name are INDEPENDENT** (design D1.7): a member tab
keeps its own `TabMeta.color`/`name`; the group's `color`/`name` render as a separate
channel. Never overwrite one with the other.

## Ids (`shared/session-ids.ts`)

```ts
const GROUP_ID_RE = /^g[0-9a-z]{5,12}$/;
export const isGroupId = (v: unknown): v is string => typeof v === 'string' && GROUP_ID_RE.test(v);
// generator: 'g' + Math.random-free counter/base36; regenerate on collision with a live id.
```

Shape-distinct from `isTabId` (`/^(?:0|[1-9]\d{0,3})$/`) so the two id spaces never
collide. **Validation matrix** for the parses:

| field                                             | validator                         | site                                        |
| ------------------------------------------------- | --------------------------------- | ------------------------------------------- |
| `groupCreate.ids`, `groupUpdate.addIds/removeIds` | `isTabId` (each), len ≤ 1000      | `parseClientMessage`                        |
| `groupUpdate.id`, `TabGroup.id`                   | `isGroupId`                       | `parseClientMessage` / `parseServerMessage` |
| `TabMeta.groupId`                                 | `isGroupId` (else drop the field) | `parseTabMeta`, `parsePersistedTabs`        |

## Persistence (design D1.2 — sidecar, NOT a shape change to tabs.json)

`tabs.json` STAYS a bare `PersistedTab[]`; `PersistedTab` gains an additive
`groupId?: string` (the old selective-copy parser in `tabs-store.ts` ignores unknown
fields → rollback-safe). Group metadata lives in a **sidecar** next to it:

```
~/.config/palmux/tabs.json     [ {id,kind,…,groupId?}, … ]   (array, unchanged shape)
~/.config/palmux/groups.json   [ {id,name?,color}, … ]        (NEW; missing = no groups)
```

- Members are DERIVED from per-tab `groupId` — never stored twice.
- On restore: load `groups.json`; then for each tab drop its `groupId` if that group id
  is not in the loaded set (a dangling membership self-heals).
- `tabs-store.ts` gains a parallel `createGroupsStore(dir)` (same atomic temp+rename,
  debounce, forgiving-parse pattern as the tabs store).
- An old server: reads `tabs.json` (ignores `groupId`), never reads `groups.json` — tabs
  load exactly as today.

## Registry state (`server.ts`)

```ts
const groups = new Map<string, { name?: string; color: string }>(); // id → meta
// membership lives on TabRecord.groupId (add `groupId?: string` to TabRecord)
```

`groupId` must be threaded through EVERY serialization boundary or it silently won't
round-trip — enumerate in tasks 1.2 / 2.1:
`TabRecord`, the restore loop (drop-if-group-missing), `persist()`, the `tabs()` broadcast
builder, `createTab`, `updateTab`, `parseTabMeta`'s `copyStrings` list, and
`parsePersistedTabs`.

## `normalizeOrder(order, groupIdOf)` — the contiguity pass

Runs after EVERY registry mutation (group op, `reorder`, `createTab`, `kill`). A STABLE
partition: each group's members collapse to the position of the group's FIRST current
member, preserving their relative order; ungrouped tabs and inter-group order are
otherwise preserved. It is the test oracle for task 1.4.

```
normalizeOrder(order: string[], groupIdOf: (id) => string|undefined): string[]
  seen = new Set<groupId>()
  out = []
  for id in order:
    g = groupIdOf(id)
    if g == undefined:            # ungrouped tab keeps its slot
      out.push(id); continue
    if g in seen: continue         # a later member — already emitted with its block
    seen.add(g)
    # emit ALL members of g, in their current relative order within `order`
    for m in order where groupIdOf(m) == g: out.push(m)
  return out
```

Worked examples (also the task-1.4 assertions):

| input order                                                    | groups          | normalized                                         |
| -------------------------------------------------------------- | --------------- | -------------------------------------------------- |
| `[t0,t1,t2,t3]`                                                | G={t0,t3}       | `[t0,t3,t1,t2]` (block at t0's slot, t3 pulled up) |
| `[t0,t1,t2,t3]`                                                | G={t1,t2}       | `[t0,t1,t2,t3]` (already contiguous — no-op)       |
| `[t1,t0,t2]` reorder tries to split G={t0,t2} to `[t0,t1,t2]`  | G={t0,t2}       | `[t0,t2,t1]` (t1 pushed out of the span)           |
| join: `order=[t0,tX,t1,t2]`, then tX gets groupId G={t0,t1,t2} | G={t0,tX,t1,t2} | `[t0,tX,t1,t2]` (stable → tX lands where dropped)  |

Because the partition is STABLE, a join drop that (a) sets the full `order` with the new
member at the drop index and (b) sets its `groupId` lands the member exactly there — no
bounce. This is why `groupUpdate` carries `order` (design D1.1).
