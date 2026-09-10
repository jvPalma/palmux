# Collapse / auto-expand state machine

Per-device group collapse is view state layered over the shared group model, exactly
like the split (`palmux-split`). This doc pins the EXACT App.tsx wiring, correcting the
design's original (wrong) "everything funnels through selectTab" claim. Referenced by
spec Requirement "Collapse is per-device view state" and tasks 3.2 / 3.3.

## State

```
localStorage['palmux-collapsed-groups'] = string[]   // collapsed groupIds
```

- Parse forgiving (corrupt → `[]`), same posture as `parseSplit`.
- Pruned against live groups on EVERY `sessions` broadcast (drop ids no longer present).
- Shared by desktop strip AND mobile drawer (design D1.6) — same set, same toggle.

## Rendering effect

- Desktop `SessionTabs`: a collapsed group renders ONLY its chip (+ a member-count badge);
  its member tabs are filtered out of the render list.
- Mobile `SessionDrawer`: a collapsed group renders ONLY its header (+ count); member rows
  hidden. Members always render in strip/broadcast order — the drawer must NOT numeric-sort
  grouped members (its current `Number(a.id)-Number(b.id)` fallback would scramble them).

## Auto-expand — ONE centralized effect (design D1.3, critical)

**Do NOT hook auto-expand into `selectTab`.** In App.tsx only these reach `selectTab`:
`tabCreated` handler, `createTab`, `popstate` (`onPop`), the popout-return `message`
handler, and the desktop strip `onSwitch`. Every SPLIT / boot / close path sets
`sessionId` DIRECTLY, bypassing `selectTab`:

| path                                 | App.tsx site                                         | reaches selectTab?       |
| ------------------------------------ | ---------------------------------------------------- | ------------------------ |
| slot click / pane focus              | `focusSlotHandler`                                   | NO — setSessionId direct |
| open/collapse/eject split            | `doSplit`, `doCollapse`, `doDropSplit`, `doDropSlot` | NO                       |
| split reconcile                      | the `reconcileSplit` effect                          | NO                       |
| close-navigation (active tab killed) | sessions handler `neighborAfterClose` branch         | NO                       |
| boot                                 | `useState(sessionIdFromPath(...))` initializer       | NO                       |

So the ONLY reliable trigger is `sessionId` itself. Add:

```ts
useEffect(() => {
  const gid = groupIdOf(sessionId); // from the live tabs/groups
  if (gid && collapsedSet.has(gid)) expand(gid); // remove gid from palmux-collapsed-groups
}, [sessionId, groups]); // `groups` dep: on boot, groups arrive on the first broadcast
// AFTER first paint → the effect re-runs and expands then.
```

This catches every path (they all end at `setSessionId`) and the async-boot case. Result:
the app can never show an active-but-hidden tab (chip collapsed, no active tab on strip,
pane mounted off-strip).

## Collapse toggle guard (chip click / header tap)

```
onToggle(gid):
  if collapsedSet.has(gid): expand(gid); return           # expanding is always safe
  # collapsing:
  active = sessionId
  if groupIdOf(active) == gid:                             # active tab is inside gid
    target = nearestOutside(gid)                           # see below
    if target == null:
      showToast("Can't collapse — every tab is in this group"); return   # REFUSE
    selectTab(target)                                      # navigate out first
  collapse(gid)                                            # add gid to the set
```

`nearestOutside(gid)` = `neighborAfterClose` semantics over the strip MINUS gid's span:
the tab immediately BEFORE the group's first member, else immediately AFTER its last
member, else null. Same left-else-right feel as close-navigation (`tab-meta.ts`
`neighborAfterClose`), so collapse-nav and close-nav are indistinguishable to the user.

## Boot force-expand

The centralized effect handles boot: the initial `sessionId` may point into a collapsed
group, but its `groups` dep fires when the first `sessions` broadcast lands and expands
before the user can perceive a hidden-active tab. No separate boot path needed.

## Interaction with the last-outside-tab-closed case (spec scenario)

Group G collapsed; collapse was allowed because exactly one tab sat outside G (the active
one). Closing that outside tab → the sessions-handler close-nav runs `neighborAfterClose`
over the full order (which still lists G's hidden members) → `setSessionId` onto a member
of collapsed G. The centralized effect then fires (sessionId changed, member ∈ collapsed
G) and expands G — so the newly-active member is visible. Verified by the "Hidden member
activation expands (any path)" scenario.
