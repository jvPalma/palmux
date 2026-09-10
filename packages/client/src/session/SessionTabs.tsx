// ── Chrome-style session tab strip (desktop) ──────────────────────────────────
//
// Browser-tab visuals: rounded-top tabs, the active one elevated and visually
// continuous with the content below, kind icon in the favicon slot, ✕ on the
// active/hovered tab, + at the end. Interactions: click switches (active click
// is a no-op — closing is ONLY the ✕), double-click renames inline,
// right-click opens rename/color/split/group/close. A colored tab shows a
// Chrome-tab-group style top-edge accent. Tab GROUPS render a colored chip
// before their first member and frame the members as a cluster (a separate
// color channel from each tab's own accent). Presentational: all
// mutation is via callbacks; the group model + view state live in App.

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
import { buildStrip, NO_COLLAPSED } from './tab-groups';
import { tabsExcept, tabsToTheRight } from './close-many';

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
   * (grow-a-group gesture). App resolves reorder vs join vs leave.
   */
  onReorder?: ((id: string, index: number, joinGid?: string) => void) | undefined;
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
  /** Chip block move: relocate the whole group to visible insertion `index`. */
  onMoveGroup?: ((gid: string, index: number) => void) | undefined;
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
  const entryIndexByPos = new Map<number, number>();
  let entryCount = 0;
  strip.forEach((item, pos) => {
    if (item.kind === 'chip') return;
    entryIndexByPos.set(pos, entryCount);
    entryCount += 1;
  });
  // O(1) group lookup reused across the strip render.
  const groupById = new Map((groups ?? []).map((g) => [g.id, g]));
  // The active tab's group (if any) — drives the chip's solid 'member-active'
  // fill. Uses `current` after the empty-current handling above (no active tab
  // when current is empty).
  const currentGroupId = current ? list.find((t) => t.id === current)?.groupId : undefined;

  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [groupRenaming, setGroupRenaming] = useState<{ gid: string; value: string } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenuState | null>(null);
  // Insertion index while a tab/chip drag hovers the strip (Chrome-style).
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // The member index a center-hover would JOIN — drives the group-colored
  // "will-join" highlight (distinct from the plain reorder insertion bar).
  const [joinArmedIndex, setJoinArmedIndex] = useState<number | null>(null);
  const renameCancelled = useRef(false);
  const stripRef = useRef<HTMLDivElement>(null);
  // When a tab drag hovers a member tab's CENTER, joining that group on drop.
  // Kept in a ref so the drop handler reads the latest value synchronously.
  const centerJoinRef = useRef<string | null>(null);

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

  // Complete a drop at the current dropIndex (tab reorder/join OR chip block move).
  const commitDrop = (e: React.DragEvent) => {
    const index = dropIndex;
    const join = centerJoinRef.current;
    setDropIndex(null);
    setJoinArmedIndex(null);
    centerJoinRef.current = null;
    if (index === null) return;
    if (dndTypes(e).includes(GROUP_DND_TYPE)) {
      const gid = e.dataTransfer.getData(GROUP_DND_TYPE);
      if (gid) onMoveGroup?.(gid, index);
    } else if (dndTypes(e).includes(TAB_DND_TYPE)) {
      const id = e.dataTransfer.getData(TAB_DND_TYPE);
      // Only pass joinGid when a center-join is pending — a plain reorder stays a
      // 2-arg call (the strip's back-compat contract).
      if (id && join) onReorder?.(id, index, join);
      else if (id) onReorder?.(id, index);
    }
  };

  const stripDragActive = !!onReorder || !!onMoveGroup;

  // The reorder insertion bar for one entry (plain tab OR fused pair): a bar
  // before it when the drop lands on its index, an after-bar on the last entry
  // when the drop appends at the end.
  const markFor = (entryIndex: number) =>
    dropIndex === entryIndex
      ? ' drop-before'
      : dropIndex === entryCount && entryIndex === entryCount - 1
        ? ' drop-after'
        : '';

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
              // Over the trailing area (not a tab/chip) → append at the end.
              const el = e.target as HTMLElement;
              if (!el.closest('.ctab') && !el.closest('.group-chip')) {
                setDropIndex(entryCount);
                centerJoinRef.current = null;
              }
            }
          : undefined
      }
      onDragLeave={
        stripDragActive
          ? (e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDropIndex(null);
                setJoinArmedIndex(null);
                centerJoinRef.current = null;
              }
            }
          : undefined
      }
      onDrop={stripDragActive ? commitDrop : undefined}
    >
      {strip.map((item, stripPos) => {
        if (item.kind === 'chip') {
          const g = item.group;
          const chipAccent = tabColorValue(g.color);
          const chipStyle: Record<string, string> = {
            '--group-ink': tabColorInk(g.color) ?? 'var(--t-accent-ink)',
          };
          if (chipAccent) chipStyle['--group-accent'] = chipAccent;
          const chipMemberActive = !!currentGroupId && currentGroupId === g.id;
          // The visible insertion index for "drop just before this group's block"
          // — the count of tab items ahead of the chip. Keeps a drop hovering a
          // chip (esp. a COLLAPSED one, whose members aren't drop targets) landing
          // at the block edge instead of a stale index.
          const insertAt = strip
            .slice(0, stripPos)
            .reduce((n, s) => n + (s.kind === 'chip' ? 0 : 1), 0);
          return (
            <div
              key={`chip-${g.id}`}
              className={`group-chip${item.collapsed ? ' collapsed' : ''}${chipMemberActive ? ' member-active' : ''}`}
              style={chipStyle}
              data-testid={`group-chip-${g.id}`}
              draggable={!!onMoveGroup && groupRenaming?.gid !== g.id}
              onDragStart={(e) => {
                e.dataTransfer.setData(GROUP_DND_TYPE, g.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={
                stripDragActive
                  ? (e) => {
                      const types = dndTypes(e);
                      if (!types.includes(TAB_DND_TYPE) && !types.includes(GROUP_DND_TYPE)) return;
                      e.preventDefault();
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = 'move';
                      centerJoinRef.current = null;
                      setJoinArmedIndex(null);
                      setDropIndex(insertAt);
                    }
                  : undefined
              }
              onDragEnd={() => {
                setDropIndex(null);
                setJoinArmedIndex(null);
                centerJoinRef.current = null;
              }}
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
          const groupColor = a.groupId ? groupById.get(a.groupId)?.color : undefined;
          const groupAccent = a.groupId ? tabColorValue(groupColor) : undefined;
          const fusedStyle: Record<string, string> = {};
          if (grouped) {
            if (groupAccent) fusedStyle['--group-accent'] = groupAccent;
            fusedStyle['--group-ink'] = tabColorInk(groupColor) ?? 'var(--t-accent-ink)';
          }
          return (
            <div
              key={`fused-${a.id}-${b.id}`}
              className={`ctab fused${isActive ? ' active' : ''}${grouped ? ' grouped' : ''}${markFor(entryIndex)}`}
              style={Object.keys(fusedStyle).length ? fusedStyle : undefined}
              data-testid={`fused-tab-${a.id}-${b.id}`}
              draggable={!!onDrag && renaming?.id !== a.id && renaming?.id !== b.id}
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_DND_TYPE, a.id);
                e.dataTransfer.effectAllowed = 'move';
                onDrag?.(a.id);
              }}
              onDragEnd={() => {
                setDropIndex(null);
                setJoinArmedIndex(null);
                centerJoinRef.current = null;
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
                      setDropIndex(rel < 0.5 ? entryIndex : entryIndex + 1);
                    }
                  : undefined
              }
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                if (!onDrag) e.preventDefault();
              }}
            >
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
                    <span className="ctab-icon" aria-hidden="true">
                      {kindIcon(m.kind)}
                    </span>
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
              onDrag?.(tab.id);
            }}
            onDragEnd={() => {
              setDropIndex(null);
              setJoinArmedIndex(null);
              centerJoinRef.current = null;
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
                      setDropIndex(tabIndex);
                    } else {
                      centerJoinRef.current = null;
                      setJoinArmedIndex(null);
                      setDropIndex(rel < 0.5 ? tabIndex : tabIndex + 1);
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
            <span className="ctab-icon" aria-hidden="true">
              {kindIcon(tab.kind)}
            </span>
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
              {isDirty ? '●' : '✕'}
            </button>
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
        +
      </button>

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
            Rename
          </button>
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
                <span className="menu-group-dot" style={{ background: tabColorValue(g.color) }} />{' '}
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
              Open in new window
            </button>
          )}
          <button
            className="tab-menu-item"
            data-testid="menu-close"
            onClick={() => {
              setMenu(null);
              onClose(menuTab.id);
            }}
          >
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
