import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { createSessionRegistry, type SessionRegistry } from './server';
import { createTabsStore, memoryGroupsStore, memoryTabsStore } from './tabs-store';
import { memoryRestoreStore } from './session-restore';

const cfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [] };

// PTYs spawned here are real shells — track registries so afterAll reaps them.
const registries: SessionRegistry[] = [];
// A memory restore store, always: with the default the registry reads the REAL
// <configDir>/sessions/, so a live palmux writing a snapshot mid-run decided
// whether this file passed.
const make = (store = memoryTabsStore(), groupsStore = memoryGroupsStore()) => {
  const r = createSessionRegistry(cfg, store, groupsStore, undefined, memoryRestoreStore());
  registries.push(r);
  return r;
};
afterAll(() => {
  for (const r of registries) for (const id of r.ids()) r.kill(id);
});

describe('tab registry — kinds and metadata', () => {
  it('createTab assigns the lowest free id and broadcasts', () => {
    const reg = make();
    let broadcasts = 0;
    reg.onListChanged(() => broadcasts++);
    expect(reg.createTab({ kind: 'web', url: 'https://sb.local' })).toBe('0');
    expect(reg.createTab({ kind: 'editor' })).toBe('1');
    expect(broadcasts).toBe(2);
    expect(reg.tabs()).toEqual([
      { id: '0', kind: 'web', url: 'https://sb.local' },
      { id: '1', kind: 'editor' },
    ]);
    expect(reg.kindOf('0')).toBe('web');
    expect(reg.has('0')).toBe(true);
  });

  it('rejects a web tab without a url', () => {
    const reg = make();
    expect(reg.createTab({ kind: 'web' })).toBeNull();
    expect(reg.tabs()).toEqual([]);
  });

  it('rejects a web tab with a non-embeddable url (javascript:/data:/protocol-relative)', () => {
    const reg = make();
    expect(reg.createTab({ kind: 'web', url: 'javascript:alert(1)' })).toBeNull();
    expect(reg.createTab({ kind: 'web', url: '//evil.com' })).toBeNull();
    expect(reg.createTab({ kind: 'web', url: 'data:text/html,x' })).toBeNull();
    expect(reg.tabs()).toEqual([]);
    // A good one still works.
    expect(reg.createTab({ kind: 'web', url: 'https://ok.dev' })).toBe('0');
  });

  it('ignores a non-embeddable url on updateTab', () => {
    const reg = make();
    reg.createTab({ kind: 'web', url: 'https://ok.dev' }); // 0
    reg.updateTab('0', { url: 'javascript:alert(1)' });
    expect(reg.tabs()[0]).toMatchObject({ url: 'https://ok.dev' });
    reg.updateTab('0', { url: '/artifacts/a.html' });
    expect(reg.tabs()[0]).toMatchObject({ url: '/artifacts/a.html' });
  });

  it('fills the lowest gap after a kill', () => {
    const reg = make();
    reg.createTab({ kind: 'dashboard' }); // 0
    reg.createTab({ kind: 'editor' }); // 1
    reg.kill('0');
    expect(reg.has('0')).toBe(false);
    expect(reg.createTab({ kind: 'editor' })).toBe('0');
  });

  it('updateTab renames/recolors, empty string clears, url only applies to web', () => {
    const reg = make();
    reg.createTab({ kind: 'web', url: 'https://a' }); // 0
    reg.createTab({ kind: 'editor' }); // 1
    expect(reg.updateTab('0', { name: 'notes', color: 'blue' })).toBe(true);
    expect(reg.tabs()[0]).toEqual({
      id: '0',
      kind: 'web',
      url: 'https://a',
      name: 'notes',
      color: 'blue',
    });
    reg.updateTab('0', { name: '', url: 'https://b' });
    expect(reg.tabs()[0]).toEqual({ id: '0', kind: 'web', url: 'https://b', color: 'blue' });
    reg.updateTab('1', { url: 'https://nope' }); // ignored on non-web
    expect(reg.tabs()[1]).toEqual({ id: '1', kind: 'editor' });
    expect(reg.updateTab('9', { name: 'x' })).toBe(false);
  });

  it('killing a non-terminal tab removes it without touching any process', () => {
    const reg = make();
    reg.createTab({ kind: 'web', url: 'https://a' });
    reg.kill('0');
    expect(reg.ids()).toEqual([]);
  });

  it('get() refuses a non-terminal id (bridge routes those away)', () => {
    const reg = make();
    reg.createTab({ kind: 'web', url: 'https://a' });
    expect(() => reg.get('0')).toThrow(/not terminal/);
  });
});

describe('tab registry — persistence', () => {
  it('restores non-terminal tabs fully; terminal entries re-label on respawn', () => {
    const store = memoryTabsStore([
      { id: '1', kind: 'web', url: 'https://sb.local', name: 'SB', color: 'teal' },
      { id: '2', kind: 'terminal', name: 'api', color: 'red' },
      { id: '3', kind: 'editor' },
      { id: '4', kind: 'terminal' }, // bare terminal: nothing to remember → dropped
    ]);
    const reg = make(store);
    // Web + editor come back fully; the NAMED terminal comes back as a dormant
    // tab (listed, switchable) but the bare terminal 4 is dropped.
    expect(reg.tabs()).toEqual([
      { id: '1', kind: 'web', url: 'https://sb.local', name: 'SB', color: 'teal' },
      { id: '2', kind: 'terminal', name: 'api', color: 'red' },
      { id: '3', kind: 'editor' },
    ]);
    reg.get('2'); // attach → spawn → the dormant slot keeps its identity
    const tab2 = reg.tabs().find((t) => t.id === '2');
    expect(tab2).toMatchObject({ kind: 'terminal', name: 'api', color: 'red' });
  });

  it('a dormant terminal is listable, renamable, and killable without attaching', () => {
    const store = memoryTabsStore([{ id: '2', kind: 'terminal', name: 'api', color: 'red' }]);
    const reg = make(store);
    expect(reg.ids()).toEqual(['2']);
    expect(reg.updateTab('2', { name: 'prod' })).toBe(true);
    expect(reg.tabs()[0]).toMatchObject({ id: '2', name: 'prod' });
    reg.kill('2'); // no live PTY — removes it directly
    expect(reg.ids()).toEqual([]);
    expect(reg.tabs()).toEqual([]);
  });

  it('createTab skips a dormant terminal id instead of silently reusing it', () => {
    const store = memoryTabsStore([{ id: '0', kind: 'terminal', name: 'prod-db' }]);
    const reg = make(store);
    // Old behavior silently handed out id 0 and inherited "prod-db"; now the
    // dormant slot is a real tab, so the new tab takes the next free id.
    expect(reg.createTab({ kind: 'dashboard' })).toBe('1');
    expect(reg.tabs()).toEqual([
      { id: '0', kind: 'terminal', name: 'prod-db' },
      { id: '1', kind: 'dashboard' },
    ]);
  });
});

describe('tabs-store (file-backed)', () => {
  it('writes debounced and loads back what it wrote', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'palmux-tabs-'));
    const store = createTabsStore(dir);
    store.save([{ id: '0', kind: 'web', url: 'https://a' }]);
    await new Promise((r) => setTimeout(r, 250));
    expect(JSON.parse(readFileSync(join(dir, 'tabs.json'), 'utf8'))).toEqual([
      { id: '0', kind: 'web', url: 'https://a' },
    ]);
    expect(createTabsStore(dir).load()).toEqual([{ id: '0', kind: 'web', url: 'https://a' }]);
  });

  it('returns an empty list for a corrupt or missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'palmux-tabs-'));
    expect(createTabsStore(dir).load()).toEqual([]);
    writeFileSync(join(dir, 'tabs.json'), '{not json');
    expect(createTabsStore(dir).load()).toEqual([]);
  });

  it('drops malformed and duplicate entries on load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'palmux-tabs-'));
    writeFileSync(
      join(dir, 'tabs.json'),
      JSON.stringify([
        { id: '0', kind: 'web', url: 'https://a' },
        { id: '0', kind: 'editor' }, // duplicate id
        { id: 'abc', kind: 'web', url: 'https://b' }, // non-numeric id
        { id: '1', kind: 'popup' }, // unknown kind
        'junk',
      ]),
    );
    expect(createTabsStore(dir).load()).toEqual([{ id: '0', kind: 'web', url: 'https://a' }]);
  });
});

describe('tab registry — display order (tab-reorder)', () => {
  it('new tabs append even when they recycle a lower id', () => {
    const reg = make();
    reg.createTab({ kind: 'editor' }); // 0
    reg.createTab({ kind: 'editor' }); // 1
    reg.createTab({ kind: 'editor' }); // 2
    reg.kill('1');
    expect(reg.ids()).toEqual(['0', '2']);
    expect(reg.createTab({ kind: 'editor' })).toBe('1'); // lowest free id…
    expect(reg.ids()).toEqual(['0', '2', '1']); // …but appended, not sorted in
  });

  it('reorder applies a permutation, persists it, and broadcasts', () => {
    const store = memoryTabsStore();
    const reg = make(store);
    reg.createTab({ kind: 'editor' });
    reg.createTab({ kind: 'editor' });
    reg.createTab({ kind: 'editor' });
    let broadcasts = 0;
    reg.onListChanged(() => broadcasts++);
    expect(reg.reorder(['2', '0', '1'])).toBe(true);
    expect(reg.ids()).toEqual(['2', '0', '1']);
    expect(reg.tabs().map((t) => t.id)).toEqual(['2', '0', '1']);
    expect(broadcasts).toBe(1);
    expect(store.snapshot().map((t) => t.id)).toEqual(['2', '0', '1']);
  });

  it('a no-op reorder returns false and does not broadcast', () => {
    const reg = make();
    reg.createTab({ kind: 'editor' });
    reg.createTab({ kind: 'editor' });
    let broadcasts = 0;
    reg.onListChanged(() => broadcasts++);
    expect(reg.reorder(['0', '1'])).toBe(false);
    expect(broadcasts).toBe(0);
  });

  it('a malformed reorder never loses or duplicates a tab', () => {
    const reg = make();
    reg.createTab({ kind: 'editor' }); // 0
    reg.createTab({ kind: 'editor' }); // 1
    reg.createTab({ kind: 'editor' }); // 2
    // Unknown id, duplicate, and omitted '1': knowns dedup to [2,0]; the
    // omitted '1' keeps its prior relative position at the end.
    expect(reg.reorder(['9', '2', '2', '0'])).toBe(true);
    expect(reg.ids()).toEqual(['2', '0', '1']);
  });

  it('order survives a store round-trip (tabs.json array order)', () => {
    const store = memoryTabsStore();
    const a = make(store);
    a.createTab({ kind: 'editor' });
    a.createTab({ kind: 'web', url: 'https://sb.local' });
    a.createTab({ kind: 'editor' });
    a.reorder(['1', '2', '0']);
    const b = make(store); // fresh registry, same store
    expect(b.ids()).toEqual(['1', '2', '0']);
  });
});

// An `editor` tab is TWO things, told apart by `url`. Without one it is the
// tab's own note at /pane-file?tab=<id>, exactly as before. WITH an absolute
// path it is a file on disk, which is how the Explorer opens a file as a tab
// instead of an overlay covering the terminal.
describe('editor tab kind', () => {
  it('carries an absolute file path, or none at all', () => {
    const reg = make();
    expect(reg.createTab({ kind: 'editor', url: '/home/user/.claude.json' })).toBe('0');
    expect(reg.createTab({ kind: 'editor' })).toBe('1'); // the tab's own note
    expect(reg.tabs()[0]).toMatchObject({ kind: 'editor', url: '/home/user/.claude.json' });
    expect(reg.tabs()[1]!.url).toBeUndefined();
  });

  // Same gate as markdown: a relative path would be resolved against whatever
  // the server's cwd happens to be, which is not a thing the client can know.
  it('rejects a relative path outright', () => {
    const reg = make();
    expect(reg.createTab({ kind: 'editor', url: 'relative/a.ts' })).toBeNull();
  });

  it('updateTab moves the path only to another absolute path', () => {
    const reg = make();
    reg.createTab({ kind: 'editor', url: '/a/b.ts' });
    expect(reg.updateTab('0', { url: '/a/c.ts' })).toBe(true);
    expect(reg.tabs()[0]!.url).toBe('/a/c.ts');
    reg.updateTab('0', { url: 'nope.ts' });
    expect(reg.tabs()[0]!.url).toBe('/a/c.ts');
  });
});

describe('markdown tab kind', () => {
  it('creates with an absolute path, path-less, and rejects a relative path', () => {
    const reg = make();
    expect(reg.createTab({ kind: 'markdown', url: '/home/user/notes/a.md' })).toBe('0');
    expect(reg.createTab({ kind: 'markdown' })).toBe('1'); // browser view
    expect(reg.createTab({ kind: 'markdown', url: 'relative/a.md' })).toBeNull();
    expect(reg.tabs()[0]).toMatchObject({ kind: 'markdown', url: '/home/user/notes/a.md' });
    expect(reg.tabs()[1]).toMatchObject({ kind: 'markdown' });
  });

  it('updateTab moves the path only to another absolute path', () => {
    const reg = make();
    reg.createTab({ kind: 'markdown', url: '/a/b.md' });
    expect(reg.updateTab('0', { url: '/a/c.md' })).toBe(true);
    expect(reg.tabs()[0]!.url).toBe('/a/c.md');
    reg.updateTab('0', { url: 'not-absolute.md' }); // silently ignored
    expect(reg.tabs()[0]!.url).toBe('/a/c.md');
  });

  it('markdown tabs persist through the store round-trip', () => {
    const store = memoryTabsStore();
    const a = make(store);
    a.createTab({ kind: 'markdown', url: '/docs/readme.md' });
    const b = make(store);
    expect(b.tabs()[0]).toMatchObject({ kind: 'markdown', url: '/docs/readme.md' });
  });
});

describe('tab groups', () => {
  const editors = (reg: SessionRegistry, n: number) => {
    for (let i = 0; i < n; i++) reg.createTab({ kind: 'editor' });
  };

  it('normalizeOrder: grouping scattered tabs pulls them contiguous', () => {
    const reg = make();
    editors(reg, 4); // 0,1,2,3
    const gid = reg.groupCreate(['0', '3'], { name: 'proj', color: 'blue' });
    expect(gid).toMatch(/^g[0-9a-z]{5,12}$/);
    expect(reg.ids()).toEqual(['0', '3', '1', '2']); // block at 0's slot, 3 pulled up
    expect(reg.groups()).toEqual([{ id: gid, name: 'proj', color: 'blue' }]);
    expect(reg.tabs().find((t) => t.id === '3')!.groupId).toBe(gid);
  });

  it('a reorder that would fragment a group is normalized back', () => {
    const reg = make();
    editors(reg, 3);
    reg.groupCreate(['0', '2'], { color: 'green' });
    // Try to interleave t1 between the members:
    reg.reorder(['0', '1', '2']);
    expect(reg.ids()).toEqual(['0', '2', '1']); // t1 pushed out of the span
  });

  it('a group of one is valid; grows via addIds; empty group dissolves', () => {
    const reg = make();
    editors(reg, 2);
    const gid = reg.groupCreate(['0'], { color: 'red' })!;
    expect(reg.groups()).toHaveLength(1); // group-of-one is legal
    expect(reg.groupUpdate(gid, { addIds: ['1'] })).toBe(true);
    expect(reg.tabs().map((t) => t.groupId)).toEqual([gid, gid]);
    // remove both → group auto-dissolves
    reg.groupUpdate(gid, { removeIds: ['0', '1'] });
    expect(reg.groups()).toEqual([]);
    expect(reg.tabs().every((t) => t.groupId === undefined)).toBe(true);
  });

  it('joining a second group steals the tab (at most one group)', () => {
    const reg = make();
    editors(reg, 3);
    const g1 = reg.groupCreate(['0', '1'], { color: 'blue' })!;
    const g2 = reg.groupCreate(['2'], { color: 'green' })!;
    reg.groupUpdate(g2, { addIds: ['1'] }); // steal t1 from g1
    expect(reg.tabs().find((t) => t.id === '1')!.groupId).toBe(g2);
    expect(reg.groups().map((g) => g.id)).toEqual(expect.arrayContaining([g1, g2]));
  });

  it('killing the last member dissolves the group', () => {
    const reg = make();
    editors(reg, 2);
    reg.groupCreate(['1'], { color: 'teal' });
    expect(reg.groups()).toHaveLength(1);
    reg.kill('1');
    expect(reg.groups()).toEqual([]);
  });

  it('groupCreate with no known ids is a no-op (null)', () => {
    const reg = make();
    editors(reg, 1);
    expect(reg.groupCreate([], { color: 'red' })).toBeNull();
    expect(reg.groupCreate(['999'], { color: 'red' })).toBeNull();
    expect(reg.groups()).toEqual([]);
  });

  it('groupUpdate on an unknown group is inert', () => {
    const reg = make();
    editors(reg, 1);
    expect(reg.groupUpdate('gdead00', { name: 'x' })).toBe(false);
  });

  it('assigns a default palette color when none given', () => {
    const reg = make();
    editors(reg, 1);
    reg.groupCreate(['0'], {});
    expect(reg.groups()[0]!.color).toBe('blue'); // first of GROUP_DEFAULT_COLORS
  });

  it('a join carries the order so the member lands where dropped', () => {
    const reg = make();
    editors(reg, 4); // 0,1,2,3
    const gid = reg.groupCreate(['0', '1'], { color: 'blue' })!; // [0,1,2,3]
    // drop t3 between 0 and 1: order says [0,3,1,2] + add 3 to the group
    reg.groupUpdate(gid, { addIds: ['3'], order: ['0', '3', '1', '2'] });
    expect(reg.ids()).toEqual(['0', '3', '1', '2']); // stable → 3 lands where dropped
    expect(reg.tabs().find((t) => t.id === '3')!.groupId).toBe(gid);
  });

  it('dissolve ungroups all members, keeping their own colors', () => {
    const store = memoryTabsStore();
    const reg = make(store);
    reg.createTab({ kind: 'editor', color: 'peach' }); // t0 with its OWN color
    reg.createTab({ kind: 'editor' });
    const gid = reg.groupCreate(['0', '1'], { color: 'blue' })!;
    reg.groupUpdate(gid, { dissolve: true });
    expect(reg.groups()).toEqual([]);
    expect(reg.tabs().every((t) => t.groupId === undefined)).toBe(true);
    expect(reg.tabs().find((t) => t.id === '0')!.color).toBe('peach'); // own color intact
  });

  it('groups + memberships survive a store round-trip (sidecar)', () => {
    const store = memoryTabsStore();
    const gstore = memoryGroupsStore();
    const a = make(store, gstore);
    a.createTab({ kind: 'editor', name: 'x' });
    a.createTab({ kind: 'editor', name: 'y' });
    const gid = a.groupCreate(['0', '1'], { name: 'proj', color: 'mauve' })!;
    const b = make(store, gstore); // fresh registry, same stores
    expect(b.groups()).toEqual([{ id: gid, name: 'proj', color: 'mauve' }]);
    expect(b.tabs().map((t) => t.groupId)).toEqual([gid, gid]);
  });

  it('a BARE grouped terminal survives a restart with its membership (no name/color)', () => {
    // A terminal with no name/color is normally dropped on restore (its process
    // is gone). Group membership makes it worth keeping — else a restart would
    // silently fragment the group by losing bare members.
    const store = memoryTabsStore([
      { id: '0', kind: 'terminal', groupId: 'gaa11111' },
      { id: '1', kind: 'terminal', name: 'api', groupId: 'gaa11111' },
    ]);
    const gstore = memoryGroupsStore([{ id: 'gaa11111', color: 'blue', name: 'svc' }]);
    const reg = make(store, gstore);
    expect(reg.tabs().map((t) => t.id)).toEqual(['0', '1']); // bare member kept
    expect(reg.tabs().map((t) => t.groupId)).toEqual(['gaa11111', 'gaa11111']);
    expect(reg.groups()).toEqual([{ id: 'gaa11111', color: 'blue', name: 'svc' }]);
  });

  it('a bare terminal whose group is ABSENT is still dropped (no orphan)', () => {
    // groupId present but the sidecar has no such group → membership is void, so
    // the bare terminal has nothing worth remembering and is dropped as usual.
    const store = memoryTabsStore([{ id: '0', kind: 'terminal', groupId: 'gghost1' }]);
    const reg = make(store, memoryGroupsStore());
    expect(reg.tabs()).toEqual([]);
  });

  it('restore drops a groupId whose group is absent from the sidecar', () => {
    const store = memoryTabsStore([
      { id: '0', kind: 'editor', name: 'a', groupId: 'gghost1' },
      { id: '1', kind: 'editor', name: 'b' },
    ]);
    const reg = make(store, memoryGroupsStore()); // no groups in the sidecar
    expect(reg.tabs().every((t) => t.groupId === undefined)).toBe(true);
    expect(reg.groups()).toEqual([]);
  });
});
