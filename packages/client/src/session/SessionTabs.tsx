// ── Session tab strip (desktop) ───────────────────────────────────────────────
//
// Every tab is a bordered pill: the active one is raised and ringed, a kind icon
// shows for non-terminal kinds only, a coloured tab shows a dot (colour never
// marks the active one), ✕ on the active/hovered pill, + at the end.
// Interactions: click switches (active click is a no-op — closing is ONLY the
// ✕), double-click renames inline, right-click opens
// rename/color/split/group/close. A tab GROUP renders as one framed cluster: a
// solid chip in the group colour followed by its member pills (a separate
// colour channel from each tab's own dot). A split pairing renders as one fused
// pill with a split glyph and a seam. Presentational: all mutation is via
// callbacks; the group model + view state live in App.

import {
  Fragment,
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { TabGroup, TabMeta } from '@palmux/shared';
import {
  displayTitle,
  kindIcon,
  resolveColorSlot,
  tabColorInk,
  tabColorValue,
  TAB_COLORS,
} from './tab-meta';
import { buildStrip, NO_COLLAPSED, type GroupEdge, type StripItem } from './tab-groups';
import { tabsExcept, tabsToTheRight } from './close-many';
import { Icon } from '../ui/icons';

/** Custom drag type so file drags (which carry `Files`) never trigger split. */
export const TAB_DND_TYPE = 'application/x-palmux-tab';
/** Chip block-move drag — distinct payload so split/slot zones ignore it. */
export const GROUP_DND_TYPE = 'application/x-palmux-group';

interface SessionTabsProps {
  tabs: TabMeta[];
  current: string;
  dirty: { [id: string]: boolean };
  /** Split pairings surfaced on the strip: two member ids + the focused member.
   *  A pairing whose members are visibly adjacent renders as one fused button. */
  pairings?: { a: string; b: string; focusedId: string }[] | undefined;
  /** The whole tab-group concern behind one interface (model + all group ops). */
  grouping?: TabGrouping | undefined;
  onSwitch: (id: string) => void;
  onNewTab: () => void;
  /** Close request; the App owns kind-specific confirmation. */
  onClose: (id: string) => void;
  /** Chrome's bulk closes ("other tabs" / "to the right") behind ONE confirm. */
  onCloseMany?: ((ids: string[]) => void) | undefined;
  onRename: (id: string, name: string) => void;
  onRecolor: (id: string, color: string) => void;
  /** Desktop only: open a split with this tab (undefined while already split). */
  onSplit?: ((id: string, orientation: 'row' | 'column') => void) | undefined;
  /** Open this tab in a separate browser window. */
  onPopout?: ((id: string) => void) | undefined;
  /** Desktop drag-to-split: fired with the dragged tab id on start, null on end. */
  onDrag?: ((id: string | null) => void) | undefined;
  /**
   * A completed tab drop: move to insertion `index` (into the VISIBLE tab list,
   * dragged included). `joinGid` set = the drop was on a member tab's center
   * (grow-a-group gesture) — the ONE gesture that joins. Every other drop is a
   * boundary and says so with `boundary`: a gap, a pill's or a fused pill's half,
   * a chip's half. It never joins, whatever its neighbours are. `anchor` set =
   * the boundary sits immediately before a group, which wins over `index` (a
   * collapsed group's members are not in the index space, so "before the chip"
   * and "after it" share one index). It names the GROUP: App resolves its first
   * member at commit time. App resolves reorder vs join vs leave.
   */
  onReorder?:
    | ((
        id: string,
        index: number,
        joinGid?: string,
        anchor?: GroupEdge,
        boundary?: boolean,
      ) => void)
    | undefined;
}

/**
 * The ONE resolved insertion boundary of a drag: feeds the preview marker and the
 * commit, so they cannot disagree. `index` is the entry-space insertion index;
 * `anchor` is set when the boundary sits immediately before a group (see
 * onReorder). A drop is a join only through the centre ref, never through this.
 */
interface DropTarget {
  index: number;
  anchor?: GroupEdge;
}

type ChipItem = Extract<StripItem, { kind: 'chip' }>;

/** A run of strip items rendered together: a group's framed cluster (its chip
 *  first, then the visible members) or one ungrouped pill. */
interface StripBlock {
  chip?: ChipItem;
  /** Positions in `strip`, in order. */
  positions: number[];
}

interface MenuState {
  id: string;
  x: number;
  y: number;
}
interface GroupMenuState {
  gid: string;
  x: number;
  y: number;
}

/** The whole tab-group concern as one interface — the model + every group op. */
export interface TabGrouping {
  /** Live tab groups (strip-ordered). */
  groups?: TabGroup[] | undefined;
  /** Collapsed group ids (per-device view state). */
  collapsed?: ReadonlySet<string> | undefined;
  onToggleGroup?: ((gid: string) => void) | undefined;
  onNewGroup?: ((id: string) => void) | undefined;
  onAddToGroup?: ((id: string, gid: string) => void) | undefined;
  onRemoveFromGroup?: ((id: string) => void) | undefined;
  onGroupRename?: ((gid: string, name: string) => void) | undefined;
  onGroupRecolor?: ((gid: string, color: string) => void) | undefined;
  onGroupDissolve?: ((gid: string) => void) | undefined;
  onGroupCloseAll?: ((gid: string) => void) | undefined;
  /** Chip block move: relocate the whole group to visible insertion `index`;
   *  `anchor` is the same group edge as onReorder's. */
  onMoveGroup?: ((gid: string, index: number, anchor?: GroupEdge) => void) | undefined;
}

/** The 16 ANSI swatches split into the two labeled picker rows. */
const SWATCH_ROWS: { label: string; colors: typeof TAB_COLORS }[] = [
  { label: 'normal', colors: TAB_COLORS.slice(0, 8) },
  { label: 'bright', colors: TAB_COLORS.slice(8, 16) },
];

interface SwatchRowsProps {
  /** Testid prefix, e.g. `menu-color` → `menu-color-ansi3`. */
  testidPrefix: string;
  /** Currently selected slot (resolved from a slot OR legacy color name). */
  selectedSlot: string | undefined;
  onPick: (name: string) => void;
}

/** Two labeled rows of ANSI swatches, shared by the tab and group pickers. */
export const SwatchRows = ({ testidPrefix, selectedSlot, onPick }: SwatchRowsProps) =>
  SWATCH_ROWS.map((row) => (
    <Fragment key={row.label}>
      <span className="swatch-row-label">{row.label}</span>
      <div className="swatch-row">
        {row.colors.map((c) => (
          <button
            key={c.name}
            className={`tab-swatch${selectedSlot === c.name ? ' selected' : ''}`}
            style={{ background: c.value }}
            aria-label={`Color ${c.name}`}
            data-testid={`${testidPrefix}-${c.name}`}
            onClick={() => onPick(c.name)}
          />
        ))}
      </div>
    </Fragment>
  ));

export const SessionTabs = memo(function SessionTabs({
  tabs,
  current,
  dirty,
  pairings,
  grouping,
  onSwitch,
  onNewTab,
  onClose,
  onCloseMany,
  onRename,
  onRecolor,
  onSplit,
  onPopout,
  onDrag,
  onReorder,
}: SessionTabsProps) {
  // The group model + ops arrive bundled; unpack to the names the body uses.
  const {
    groups,
    collapsed,
    onToggleGroup,
    onNewGroup,
    onAddToGroup,
    onRemoveFromGroup,
    onGroupRename,
    onGroupRecolor,
    onGroupDissolve,
    onGroupCloseAll,
    onMoveGroup,
  } = grouping ?? {};

  // The broadcast array order IS the display order (server-authoritative) —
  // never sort. A current id not broadcast yet (fresh navigation) appends at
  // the end. An EMPTY current means no active tab (the New-tab page) — no ghost.
  const list: TabMeta[] = (() => {
    if (!current || tabs.some((t) => t.id === current)) return tabs;
    const ghost: TabMeta = { id: current, kind: 'terminal' as const };
    // A not-yet-broadcast PAIRING member slots in next to its partner (slot
    // order), so the fused button renders before the server knows the tab —
    // otherwise the ghost appends at the end and the pair can't fuse yet.
    const pr = (pairings ?? []).find((p) => p.a === current || p.b === current);
    const partnerId = pr ? (pr.a === current ? pr.b : pr.a) : undefined;
    const at = partnerId !== undefined ? tabs.findIndex((t) => t.id === partnerId) : -1;
    if (at === -1) return [...tabs, ghost];
    const insertAt = pr!.a === current ? at : at + 1;
    return [...tabs.slice(0, insertAt), ghost, ...tabs.slice(insertAt)];
  })();

  const collapsedSet = collapsed ?? NO_COLLAPSED;
  // A fused pairing renders as ONE strip entry (buildStrip fuses visibly-adjacent
  // members); the focused member drives which segment lights up.
  const pairSummary = pairings?.map((p) => ({ a: p.a, b: p.b }));
  const focusedByA = new Map((pairings ?? []).map((p) => [p.a, p.focusedId] as const));
  const strip = buildStrip(list, groups ?? [], collapsedSet, pairSummary);
  // Drop-target ENTRIES: plain tabs and fused pairs each count as ONE (chips are
  // separators, not entries). This entry-index space is what onReorder receives.
  // `entryBefore[k]` is the insertion index of the boundary just before strip
  // position k (k = strip.length is the end), chips included in the walk.
  const entryIndexByPos = new Map<number, number>();
  const entryBefore: number[] = [];
  let entryCount = 0;
  strip.forEach((item, pos) => {
    entryBefore[pos] = entryCount;
    if (item.kind === 'chip') return;
    entryIndexByPos.set(pos, entryCount);
    entryCount += 1;
  });
  entryBefore[strip.length] = entryCount;
  // Render blocks: a chip opens a cluster and swallows the contiguous members
  // after it (the server guarantees contiguity); anything else stands alone. A
  // fused pair shares its first member's group. The wrapper is presentational:
  // every index above is still computed over the flat `strip`.
  const blocks: StripBlock[] = [];
  strip.forEach((item, pos) => {
    const open = blocks.at(-1);
    if (item.kind === 'chip') {
      blocks.push({ chip: item, positions: [pos] });
      return;
    }
    const gid = item.kind === 'fused' ? item.a.groupId : item.tab.groupId;
    if (gid && open?.chip?.group.id === gid) open.positions.push(pos);
    else blocks.push({ positions: [pos] });
  });
  const lastBlockIsCluster = blocks.at(-1)?.chip !== undefined;
  // O(1) group lookup reused across the strip render.
  const groupById = new Map((groups ?? []).map((g) => [g.id, g]));

  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [groupRenaming, setGroupRenaming] = useState<{ gid: string; value: string } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenuState | null>(null);
  // The resolved insertion boundary while a tab/chip drag hovers the strip.
  const [drop, setDrop] = useState<DropTarget | null>(null);
  // The member index a center-hover would JOIN — drives the group-colored
  // "will-join" highlight (distinct from the plain reorder insertion bar).
  const [joinArmedIndex, setJoinArmedIndex] = useState<number | null>(null);
  const renameCancelled = useRef(false);
  const stripRef = useRef<HTMLDivElement>(null);
  // When a tab drag hovers a member tab's CENTER, joining that group on drop.
  // Kept in a ref so the drop handler reads the latest value synchronously.
  const centerJoinRef = useRef<string | null>(null);
  // What is being dragged, recorded at dragstart: a dragover cannot read the
  // payload (browsers hide getData until the drop), and where a boundary may
  // land depends on which group the dragged entry already belongs to.
  const dragSrcRef = useRef<{ group: boolean; id: string } | null>(null);

  // Keep the active tab visible when the strip overflows.
  useEffect(() => {
    stripRef.current
      ?.querySelector('.ctab.active')
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [current, tabs.length]);

  // Context menus close on any outside press or Escape.
  useEffect(() => {
    if (!menu && !groupMenu) return;
    const close = () => {
      setMenu(null);
      setGroupMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, groupMenu]);

  const startRename = (tab: TabMeta) => {
    renameCancelled.current = false;
    setMenu(null);
    setRenaming({ id: tab.id, value: tab.name ?? '' });
  };
  const commitRename = () => {
    if (!renaming || renameCancelled.current) return;
    onRename(renaming.id, renaming.value.trim());
    setRenaming(null);
  };
  const onRenameKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitRename();
    else if (e.key === 'Escape') {
      renameCancelled.current = true;
      setRenaming(null);
    }
  };

  const commitGroupRename = () => {
    if (!groupRenaming || renameCancelled.current) return;
    onGroupRename?.(groupRenaming.gid, groupRenaming.value.trim());
    setGroupRenaming(null);
  };
  const onGroupRenameKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitGroupRename();
    else if (e.key === 'Escape') {
      renameCancelled.current = true;
      setGroupRenaming(null);
    }
  };

  const openMenu = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    setGroupMenu(null);
    setMenu({ id, x: e.clientX, y: e.clientY });
  };
  const openGroupMenu = (e: ReactMouseEvent, gid: string) => {
    e.preventDefault();
    setMenu(null);
    setGroupMenu({ gid, x: e.clientX, y: e.clientY });
  };

  const menuTab = menu ? list.find((t) => t.id === menu.id) : undefined;
  const menuGroups = (groups ?? []).filter((g) => g.id !== menuTab?.groupId);

  const dndTypes = (e: React.DragEvent) => Array.from(e.dataTransfer.types);

  // One setter for the resolved boundary: dragover fires many times a second and
  // most repeat the same boundary, so an equal one keeps the state (no re-render).
  const putDrop = (next: DropTarget) =>
    setDrop((prev) =>
      prev !== null && prev.index === next.index && prev.anchor?.groupId === next.anchor?.groupId
        ? prev
        : next,
    );
  const clearDrag = () => {
    setDrop(null);
    setJoinArmedIndex(null);
    centerJoinRef.current = null;
  };
  // Not part of clearDrag: leaving the strip mid-drag clears the preview, but the
  // drag (and what it carries) is still live if the pointer comes back.
  const endDrag = () => {
    dragSrcRef.current = null;
    clearDrag();
  };

  // The boundary just before strip position `k` (k = strip.length: the end), in
  // the entry-index space plus the anchor R3 needs. A boundary immediately before
  // a group — before its chip, or between an EXPANDED chip and its first member,
  // where a drop commits the same way (it never joins) — carries that GROUP's
  // leading edge as `anchor`. The index cannot name it: a collapsed group's
  // members are not entries, so "before the chip" and "after it" both resolve to
  // the entry that follows the group. A boundary after a group's last member (or
  // a collapsed chip) needs no anchor: that index is already the entry after it.
  const boundaryAt = (k: number): DropTarget => {
    const index = entryBefore[k] ?? entryCount;
    const next = strip[k];
    const prev = strip[k - 1];
    const chip =
      next?.kind === 'chip' ? next : prev?.kind === 'chip' && !prev.collapsed ? prev : undefined;
    return chip ? { index, anchor: { groupId: chip.group.id, edge: 'before' } } : { index };
  };

  // The strip position a pointer over EMPTY strip space (a gap between pills,
  // a cluster's padding, the `+` button, the area past the last pill) falls on:
  // before the first rendered unit (pill, fused pill or chip, in strip order)
  // whose centre is right of the pointer, else the end. It must not default to
  // "append": a tab dropped in the new 8px gaps would otherwise land at the very
  // end and a grouped one would LEAVE its group. A pointer with no x (or no
  // layout) is not left of anything, so it is the trailing area.
  const gapBoundary = (clientX: number) => {
    const units = stripRef.current?.querySelectorAll('.ctab, .group-chip') ?? [];
    for (const [k, unit] of Array.from(units).entries()) {
      const r = unit.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return Math.min(k, strip.length);
    }
    return strip.length;
  };

  // The group a strip position's pill belongs to (a fused pair: its first
  // member's — the pair shares it). Chips and the end belong to none.
  const groupAt = (pos: number) => {
    const item = strip[pos];
    if (item?.kind === 'tab') return item.tab.groupId;
    return item?.kind === 'fused' ? item.a.groupId : undefined;
  };

  // Boundary `k` between two members of a group the dragged entry is NOT in is
  // the inside of someone else's group. A tab dropped there would read as a JOIN
  // (decideGroupDrop's "between two members") although nothing previewed one, and
  // a whole group dropped there would split that group, which the server only
  // undoes. It resolves to that group's nearer outer edge by pointer distance —
  // before its chip or after its last member — so the marker shows the edge the
  // drop commits to. Inside the dragged entry's OWN group it is a plain reorder.
  // Every boundary goes through here — a gap, a pill's half, a fused pill's half
  // — because joining is the centre of a member and nothing else.
  const outsideForeignGroupAt = (k: number, clientX: number) => {
    const gid = groupAt(k - 1);
    if (gid === undefined || groupAt(k) !== gid) return k;
    const src = dragSrcRef.current;
    const own = src?.group ? src.id : list.find((t) => t.id === src?.id)?.groupId;
    if (gid === own) return k;
    let first = k - 1;
    while (first > 0 && groupAt(first - 1) === gid) first--;
    const lead = strip[first - 1];
    if (lead?.kind === 'chip' && lead.group.id === gid) first--;
    let last = k;
    while (groupAt(last + 1) === gid) last++;
    const units = stripRef.current?.querySelectorAll('.ctab, .group-chip');
    const left = units?.[first]?.getBoundingClientRect().left ?? clientX;
    const right = units?.[last]?.getBoundingClientRect().right ?? clientX;
    return clientX - left <= right - clientX ? first : last + 1;
  };

  // Complete a drop at the resolved boundary (tab reorder/join OR chip block move).
  const commitDrop = (e: React.DragEvent) => {
    const target = drop;
    const join = centerJoinRef.current;
    endDrag();
    if (target === null) return;
    const { index, anchor } = target;
    if (dndTypes(e).includes(GROUP_DND_TYPE)) {
      const gid = e.dataTransfer.getData(GROUP_DND_TYPE);
      if (!gid) return;
      if (anchor !== undefined) onMoveGroup?.(gid, index, anchor);
      else onMoveGroup?.(gid, index);
    } else if (dndTypes(e).includes(TAB_DND_TYPE)) {
      const id = e.dataTransfer.getData(TAB_DND_TYPE);
      if (!id) return;
      // The centre of a member is the only join; everything else is a boundary,
      // and saying so is what stops App reading "between two members" as a join
      // (the order alone cannot tell the two apart).
      if (join) onReorder?.(id, index, join);
      else onReorder?.(id, index, undefined, anchor, true);
    }
  };

  const stripDragActive = !!onReorder || !!onMoveGroup;

  // The group the boundary is anchored to, resolved against THIS render's strip:
  // the marker follows the group's current cluster whoever its first member is
  // now, and once the group is gone the numeric index — what App then falls back
  // to — draws it instead.
  const anchorGid = drop?.anchor?.groupId;
  const anchoredGid = strip.some((i) => i.kind === 'chip' && i.group.id === anchorGid)
    ? anchorGid
    : undefined;
  // The reorder insertion bar for one entry (plain tab OR fused pair): a bar
  // before it when the drop lands on its index. It stays off while the boundary
  // is anchored to a group (the cluster draws it, at the edge the commit uses)
  // and an after-bar on the last entry only when that entry is the strip's last
  // block — after a trailing cluster the cluster itself carries it.
  const markFor = (entryIndex: number) => {
    if (drop === null || anchoredGid !== undefined) return '';
    if (drop.index === entryIndex) return ' drop-before';
    return drop.index === entryCount && entryIndex === entryCount - 1 && !lastBlockIsCluster
      ? ' drop-after'
      : '';
  };
  // The same bar for a group's cluster: before it when the boundary is anchored
  // to that group, after it when the drop appends past a trailing cluster.
  const clusterMark = (chip: ChipItem, isLast: boolean) =>
    anchoredGid !== undefined && chip.group.id === anchoredGid
      ? ' drop-before'
      : isLast && drop !== null && anchoredGid === undefined && drop.index === entryCount
        ? ' drop-after'
        : '';

  // One strip entry: a chip, a fused pair or a plain tab. Hoisted out of the JSX so
  // the cluster wrapper can render the same entries without re-indenting them.
  const renderItem = (item: StripItem, stripPos: number) => {
    if (item.kind === 'chip') {
      const g = item.group;
      // The chip's look never depends on which tab is active: the member pill
      // carries the active treatment, the chip is the group's constant identity.
      return (
        <div
          key={`chip-${g.id}`}
          className={`group-chip${item.collapsed ? ' collapsed' : ''}`}
          data-testid={`group-chip-${g.id}`}
          draggable={!!onMoveGroup && groupRenaming?.gid !== g.id}
          onDragStart={(e) => {
            e.dataTransfer.setData(GROUP_DND_TYPE, g.id);
            e.dataTransfer.effectAllowed = 'move';
            dragSrcRef.current = { group: true, id: g.id };
          }}
          onDragOver={
            stripDragActive
              ? (e) => {
                  const types = dndTypes(e);
                  if (!types.includes(TAB_DND_TYPE) && !types.includes(GROUP_DND_TYPE)) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = 'move';
                  const r = e.currentTarget.getBoundingClientRect();
                  const rel = (e.clientX - r.left) / r.width;
                  centerJoinRef.current = null;
                  setJoinArmedIndex(null);
                  // Left half: before the group. Right half: after the chip — which
                  // for a COLLAPSED group is after the whole group, and for an
                  // expanded one is still "before its first member" (boundaryAt).
                  putDrop(boundaryAt(rel < 0.5 ? stripPos : stripPos + 1));
                }
              : undefined
          }
          onDragEnd={endDrag}
          onPointerDown={(e) => {
            if (e.button !== 0 || groupRenaming?.gid === g.id) return;
            if (!onMoveGroup) e.preventDefault();
          }}
          onClick={() => {
            if (groupRenaming?.gid === g.id) return;
            onToggleGroup?.(g.id);
          }}
          onContextMenu={(e) => openGroupMenu(e, g.id)}
        >
          {groupRenaming?.gid === g.id ? (
            <input
              className="group-chip-rename"
              data-testid="group-rename-input"
              value={groupRenaming.value}
              autoFocus
              spellCheck={false}
              placeholder="group name"
              onChange={(e) => setGroupRenaming({ gid: g.id, value: e.target.value })}
              onKeyDown={onGroupRenameKey}
              onBlur={commitGroupRename}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              <span className="group-chip-dot" aria-hidden="true" />
              <span className="group-chip-label">{g.name || 'group'}</span>
              {item.collapsed && (
                <span className="group-chip-count" data-testid={`group-count-${g.id}`}>
                  {item.memberCount}
                </span>
              )}
            </>
          )}
        </div>
      );
    }

    if (item.kind === 'fused') {
      const entryIndex = entryIndexByPos.get(stripPos)!;
      const { a, b } = item;
      const isActive = a.id === current || b.id === current;
      const focusedId = focusedByA.get(a.id);
      const grouped = !!a.groupId;
      return (
        <div
          key={`fused-${a.id}-${b.id}`}
          className={`ctab fused${isActive ? ' active' : ''}${grouped ? ' grouped' : ''}${markFor(entryIndex)}`}
          data-testid={`fused-tab-${a.id}-${b.id}`}
          draggable={!!onDrag && renaming?.id !== a.id && renaming?.id !== b.id}
          onDragStart={(e) => {
            e.dataTransfer.setData(TAB_DND_TYPE, a.id);
            e.dataTransfer.effectAllowed = 'move';
            dragSrcRef.current = { group: false, id: a.id };
            onDrag?.(a.id);
          }}
          onDragEnd={() => {
            endDrag();
            onDrag?.(null);
          }}
          onDragOver={
            stripDragActive
              ? (e) => {
                  const types = dndTypes(e);
                  if (!types.includes(TAB_DND_TYPE) && !types.includes(GROUP_DND_TYPE)) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = 'move';
                  const r = e.currentTarget.getBoundingClientRect();
                  const rel = (e.clientX - r.left) / r.width;
                  centerJoinRef.current = null;
                  setJoinArmedIndex(null);
                  // No centre gesture here: both halves are boundaries, and one
                  // inside a group the dragged entry is not in takes its edge.
                  const k = rel < 0.5 ? stripPos : stripPos + 1;
                  putDrop(boundaryAt(outsideForeignGroupAt(k, e.clientX)));
                }
              : undefined
          }
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            if (!onDrag) e.preventDefault();
          }}
        >
          {/* Leads the pill whether or not the pairing is active, so a split never
              reads as two ordinary tabs. */}
          <span
            className="fused-glyph"
            data-testid={`fused-glyph-${a.id}-${b.id}`}
            aria-hidden="true"
          >
            <Icon name="split" size={12} />
          </span>
          {[a, b].map((m) => {
            const segAccent = tabColorValue(m.color);
            const segInk = tabColorInk(m.color);
            const segStyle: Record<string, string> = {};
            if (segAccent) {
              segStyle['--tab-accent'] = segAccent;
              if (segInk) segStyle['--tab-ink'] = segInk;
            }
            return (
              // A div (like .ctab), not a button: the inline rename input
              // must be able to live inside it (no nested interactives).
              <div
                key={m.id}
                className={`fused-seg${isActive && focusedId === m.id ? ' on' : ''}`}
                style={Object.keys(segStyle).length ? segStyle : undefined}
                data-testid={`fused-seg-${m.id}`}
                role="tab"
                aria-selected={isActive && focusedId === m.id}
                onClick={(e) => {
                  if (e.button !== 0 || renaming?.id === m.id) return;
                  if (m.id !== current) onSwitch(m.id);
                }}
                onPointerDown={(e) => {
                  if (e.button === 1) e.preventDefault(); // no autoscroll
                }}
                onAuxClick={(e) => {
                  if (e.button !== 1 || renaming?.id === m.id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onClose(m.id);
                }}
                onDoubleClick={() => startRename(m)}
                onContextMenu={(e) => openMenu(e, m.id)}
              >
                {segAccent && <span className="ctab-dot" aria-hidden="true" />}
                {m.kind !== 'terminal' && (
                  <span className="ctab-icon" aria-hidden="true">
                    <Icon name={kindIcon(m.kind)} size={12} />
                  </span>
                )}
                {renaming?.id === m.id ? (
                  <input
                    className="ctab-rename"
                    data-testid="tab-rename-input"
                    value={renaming.value}
                    autoFocus
                    spellCheck={false}
                    placeholder={displayTitle(m)}
                    onChange={(e) => setRenaming({ id: m.id, value: e.target.value })}
                    onKeyDown={onRenameKey}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="ctab-title">{displayTitle(m)}</span>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    const tab = item.tab;
    const tabIndex = entryIndexByPos.get(stripPos)!;
    const isCurrent = tab.id === current;
    const active = isCurrent;
    const accent = tabColorValue(tab.color);
    const ink = tabColorInk(tab.color);
    const groupColor = tab.groupId ? groupById.get(tab.groupId)?.color : undefined;
    const groupAccent = tab.groupId ? tabColorValue(groupColor) : undefined;
    const isDirty = dirty[tab.id] === true;
    const dropMark = markFor(tabIndex);
    const style: Record<string, string> = {};
    if (accent) {
      style['--tab-accent'] = accent;
      if (ink) style['--tab-ink'] = ink;
    }
    if (tab.groupId) {
      if (groupAccent) style['--group-accent'] = groupAccent;
      style['--group-ink'] = tabColorInk(groupColor) ?? 'var(--t-accent-ink)';
    }
    return (
      <div
        key={tab.id}
        className={`ctab${active ? ' active' : ''}${tab.groupId ? ' grouped' : ''}${dropMark}${joinArmedIndex === tabIndex ? ' join-armed' : ''}`}
        style={Object.keys(style).length ? style : undefined}
        data-testid={`session-tab-${tab.id}`}
        role="tab"
        aria-selected={active}
        draggable={!!onDrag}
        onDragStart={(e) => {
          e.dataTransfer.setData(TAB_DND_TYPE, tab.id);
          e.dataTransfer.effectAllowed = 'move';
          dragSrcRef.current = { group: false, id: tab.id };
          onDrag?.(tab.id);
        }}
        onDragEnd={() => {
          endDrag();
          onDrag?.(null);
        }}
        onDragOver={
          stripDragActive
            ? (e) => {
                const types = dndTypes(e);
                if (!types.includes(TAB_DND_TYPE) && !types.includes(GROUP_DND_TYPE)) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'move';
                const r = e.currentTarget.getBoundingClientRect();
                const rel = (e.clientX - r.left) / r.width;
                // Middle third of a GROUPED tab (tab drags only) → join it.
                if (types.includes(TAB_DND_TYPE) && tab.groupId && rel > 0.34 && rel < 0.66) {
                  centerJoinRef.current = tab.groupId;
                  setJoinArmedIndex(tabIndex);
                  putDrop({ index: tabIndex });
                } else {
                  centerJoinRef.current = null;
                  setJoinArmedIndex(null);
                  // A half is a boundary, for a tab exactly as for a group: one
                  // between two members of a group the dragged entry is not in
                  // takes that group's nearer edge rather than joining it.
                  const k = rel < 0.5 ? stripPos : stripPos + 1;
                  putDrop(boundaryAt(outsideForeignGroupAt(k, e.clientX)));
                }
              }
            : undefined
        }
        onPointerDown={(e) => {
          // Middle button: swallow it here so Chrome does not start its
          // autoscroll (an auxclick preventDefault is already too late for
          // that) — the close itself happens on auxclick, like a browser.
          if (e.button === 1) {
            e.preventDefault();
            return;
          }
          if (e.button !== 0 || renaming?.id === tab.id) return;
          const target = e.target as HTMLElement;
          if (target.closest('.ctab-kill')) return; // ✕ handles itself
          if (!onDrag) e.preventDefault();
        }}
        onAuxClick={(e) => {
          if (e.button !== 1 || renaming?.id === tab.id) return;
          e.preventDefault();
          onClose(tab.id);
        }}
        onClick={(e) => {
          // Switch on CLICK, not pointerdown: starting a drag (to split or
          // reorder) must not first yank the source tab active — that would
          // corrupt the split base (the dragged tab would become both slots,
          // spawning a stray fresh terminal). A real click fires here; a
          // completed drag does not.
          if (e.button !== 0 || renaming?.id === tab.id) return;
          if ((e.target as HTMLElement).closest('.ctab-kill')) return;
          if (!isCurrent) onSwitch(tab.id);
        }}
        onDoubleClick={() => startRename(tab)}
        onContextMenu={(e) => openMenu(e, tab.id)}
      >
        {accent && <span className="ctab-dot" aria-hidden="true" />}
        {tab.kind !== 'terminal' && (
          <span className="ctab-icon" aria-hidden="true">
            <Icon name={kindIcon(tab.kind)} size={12} />
          </span>
        )}
        {renaming?.id === tab.id ? (
          <input
            className="ctab-rename"
            data-testid="tab-rename-input"
            value={renaming.value}
            autoFocus
            spellCheck={false}
            placeholder={displayTitle(tab)}
            onChange={(e) => setRenaming({ id: tab.id, value: e.target.value })}
            onKeyDown={onRenameKey}
            onBlur={commitRename}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="ctab-title">{displayTitle(tab)}</span>
        )}
        <button
          className={`ctab-kill${isDirty ? ' dirty' : ''}`}
          aria-label={`Close tab ${tab.id}`}
          data-testid={`tab-close-${tab.id}`}
          tabIndex={-1}
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onClose(tab.id);
          }}
        >
          {isDirty ? <Icon name="dot" size={14} /> : <Icon name="close" size={12} />}
        </button>
      </div>
    );
  };

  return (
    <div
      className="session-tabs"
      ref={stripRef}
      data-testid="session-tabs"
      onDragOver={
        stripDragActive
          ? (e) => {
              const types = dndTypes(e);
              if (!types.includes(TAB_DND_TYPE) && !types.includes(GROUP_DND_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              // A pill or chip resolves its own hover; this is empty strip space.
              const el = e.target as HTMLElement;
              if (!el.closest('.ctab') && !el.closest('.group-chip')) {
                centerJoinRef.current = null;
                setJoinArmedIndex(null);
                putDrop(boundaryAt(outsideForeignGroupAt(gapBoundary(e.clientX), e.clientX)));
              }
            }
          : undefined
      }
      onDragLeave={
        stripDragActive
          ? (e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) clearDrag();
            }
          : undefined
      }
      onDrop={stripDragActive ? commitDrop : undefined}
    >
      {blocks.map((block) => {
        const first = block.positions[0]!;
        if (!block.chip) return renderItem(strip[first]!, first);
        const g = block.chip.group;
        const accent = tabColorValue(g.color);
        const clusterStyle: Record<string, string> = {
          '--group-ink': tabColorInk(g.color) ?? 'var(--t-accent-ink)',
        };
        if (accent) clusterStyle['--group-accent'] = accent;
        return (
          <div
            key={`cluster-${g.id}`}
            className={`group-cluster${block.chip.collapsed ? ' collapsed' : ''}${clusterMark(block.chip, block === blocks.at(-1))}`}
            style={clusterStyle}
            data-testid={`group-cluster-${g.id}`}
          >
            {block.positions.map((pos) => renderItem(strip[pos]!, pos))}
          </div>
        );
      })}
      <button
        className="ctab-new"
        data-testid="session-new"
        aria-label="New tab"
        onPointerDown={(e) => {
          e.preventDefault();
          onNewTab();
        }}
      >
        <Icon name="plus" size={14} />
      </button>

      {/* Three groups, a hairline between each: EDIT (rename), LAYOUT (split,
          group, colour, pop out) and CLOSE, which is always last so the one
          destructive item is never in the middle of the others. Every group is
          non-empty (rename, the swatches and close always render), so both
          separators always have something on each side. */}
      {menu && menuTab && (
        <div
          className="tab-menu"
          data-testid="tab-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            className="tab-menu-item"
            data-testid="menu-rename"
            onClick={() => startRename(menuTab)}
          >
            <Icon name="pencil" />
            Rename
          </button>
          <div className="tab-menu-sep" role="separator" data-testid="tab-menu-sep" />
          {onSplit && (
            <>
              <button
                className="tab-menu-item"
                data-testid="menu-split-right"
                onClick={() => {
                  setMenu(null);
                  onSplit(menuTab.id, 'row');
                }}
              >
                <Icon name="split" />
                Split right
              </button>
              <button
                className="tab-menu-item"
                data-testid="menu-split-down"
                onClick={() => {
                  setMenu(null);
                  onSplit(menuTab.id, 'column');
                }}
              >
                {/* The same glyph turned a quarter: a vertical rule between two
                    panes becomes a horizontal one between two stacked panes. */}
                <span className="tab-menu-icon-turned">
                  <Icon name="split" />
                </span>
                Split down
              </button>
            </>
          )}
          {onNewGroup && (
            <button
              className="tab-menu-item"
              data-testid="menu-new-group"
              onClick={() => {
                setMenu(null);
                onNewGroup(menuTab.id);
              }}
            >
              <Icon name="plus" />
              New group from this tab
            </button>
          )}
          {onAddToGroup &&
            menuGroups.map((g) => (
              <button
                key={g.id}
                className="tab-menu-item"
                data-testid={`menu-add-to-${g.id}`}
                onClick={() => {
                  setMenu(null);
                  onAddToGroup(menuTab.id, g.id);
                }}
              >
                <Icon name="plus" />
                <span
                  className="menu-group-dot"
                  style={{ background: tabColorValue(g.color) }}
                />{' '}
                Add to {g.name || 'group'}
              </button>
            ))}
          {onRemoveFromGroup && menuTab.groupId && (
            <button
              className="tab-menu-item"
              data-testid="menu-remove-from-group"
              onClick={() => {
                setMenu(null);
                onRemoveFromGroup(menuTab.id);
              }}
            >
              <Icon name="eject" />
              Remove from group
            </button>
          )}
          <div className="tab-menu-colors">
            <SwatchRows
              testidPrefix="menu-color"
              selectedSlot={resolveColorSlot(menuTab.color)}
              onPick={(name) => {
                onRecolor(menuTab.id, name);
                setMenu(null);
              }}
            />
            <button
              className={`tab-swatch none${!menuTab.color ? ' selected' : ''}`}
              aria-label="No color"
              data-testid="menu-color-none"
              onClick={() => {
                onRecolor(menuTab.id, '');
                setMenu(null);
              }}
            >
              ∅
            </button>
          </div>
          {onPopout && (
            <button
              className="tab-menu-item"
              data-testid="menu-popout"
              onClick={() => {
                setMenu(null);
                onPopout(menuTab.id);
              }}
            >
              <Icon name="external" />
              Open in new window
            </button>
          )}
          <div className="tab-menu-sep" role="separator" data-testid="tab-menu-sep" />
          <button
            className="tab-menu-item"
            data-testid="menu-close"
            onClick={() => {
              setMenu(null);
              onClose(menuTab.id);
            }}
          >
            <Icon name="close" />
            Close
          </button>
          {/* Chrome's two bulk closes. Computed from the FULL tab order, not the
              visible entries: whether a group happens to be collapsed on this
              device must not change which tabs "to the right" means. Rendered
              only when they would do something — an item that closes nothing is
              a promise the menu cannot keep. */}
          {onCloseMany && tabsExcept(list, menuTab.id).length > 0 && (
            <button
              className="tab-menu-item"
              data-testid="menu-close-others"
              onClick={() => {
                setMenu(null);
                onCloseMany(tabsExcept(list, menuTab.id).map((t) => t.id));
              }}
            >
              <Icon name="close" />
              Close other tabs
            </button>
          )}
          {onCloseMany && tabsToTheRight(list, menuTab.id).length > 0 && (
            <button
              className="tab-menu-item"
              data-testid="menu-close-right"
              onClick={() => {
                setMenu(null);
                onCloseMany(tabsToTheRight(list, menuTab.id).map((t) => t.id));
              }}
            >
              <Icon name="close" />
              Close tabs to the right
            </button>
          )}
        </div>
      )}

      {groupMenu && (
        <div
          className="tab-menu"
          data-testid="group-menu"
          style={{ left: groupMenu.x, top: groupMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            className="tab-menu-item"
            data-testid="group-menu-rename"
            onClick={() => {
              const g = (groups ?? []).find((x) => x.id === groupMenu.gid);
              renameCancelled.current = false;
              setGroupMenu(null);
              setGroupRenaming({ gid: groupMenu.gid, value: g?.name ?? '' });
            }}
          >
            Rename group
          </button>
          <div className="tab-menu-colors">
            <SwatchRows
              testidPrefix="group-color"
              selectedSlot={resolveColorSlot(groupById.get(groupMenu.gid)?.color)}
              onPick={(name) => {
                onGroupRecolor?.(groupMenu.gid, name);
                setGroupMenu(null);
              }}
            />
          </div>
          <button
            className="tab-menu-item"
            data-testid="group-menu-ungroup"
            onClick={() => {
              setGroupMenu(null);
              onGroupDissolve?.(groupMenu.gid);
            }}
          >
            Ungroup
          </button>
          <button
            className="tab-menu-item"
            data-testid="group-menu-close-all"
            onClick={() => {
              setGroupMenu(null);
              onGroupCloseAll?.(groupMenu.gid);
            }}
          >
            Close all
          </button>
        </div>
      )}
    </div>
  );
});
