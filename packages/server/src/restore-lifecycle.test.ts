// Who deletes a restore snapshot, and when.
//
// The registry is the only owner of a snapshot's lifetime, and for a long time
// exactly one path (an explicit kill) deleted one. Every other death left the
// file behind, and because ids are recycled lowest-free, the next tab to land on
// that id silently resurrected a shell closed long ago — cwd, scrollback and the
// command typed back in. These tests pin each death separately, because they do
// NOT share a code path.

import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { createSessionRegistry, type SessionRegistry } from './server';
import { memoryGroupsStore, memoryTabsStore } from './tabs-store';
import { memoryRestoreStore, type RestoreStore, type SessionSnapshot } from './session-restore';

const cfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [] };

const registries: SessionRegistry[] = [];
const make = (restore: RestoreStore, tabs = memoryTabsStore()) => {
  const r = createSessionRegistry(cfg, tabs, memoryGroupsStore(), undefined, restore);
  registries.push(r);
  return r;
};
afterAll(() => {
  for (const r of registries) for (const id of r.ids()) r.kill(id);
});

const snap = (command: string): SessionSnapshot => ({ at: Date.now(), cwd: '/tmp', command });

/**
 * Resolve once the shell has really exited. A fixed sleep is not enough: under
 * a full-suite run a spawn can take longer than any number worth waiting, and
 * this file's whole subject is what the exit handler does. Our listener is
 * registered after the registry's, so by the time it fires the registry has
 * already run its own — which is the thing under test.
 */
const exited = (pty: { onExit(cb: () => void): void; alive: boolean }): Promise<void> =>
  new Promise((resolve) => {
    if (!pty.alive) return resolve();
    pty.onExit(() => resolve());
  });

describe('restore snapshot lifetime', () => {
  it('an explicit kill forgets the snapshot', async () => {
    const restore = memoryRestoreStore({ '0': snap('tmux attach -t work') });
    const reg = make(restore);
    const pty = reg.get('0'); // attach → spawns, consuming the snapshot
    reg.kill('0');
    await exited(pty);
    expect(restore.ids()).toEqual([]);
  });

  it('a shell that exits on its own forgets it too — the id will be recycled', async () => {
    const restore = memoryRestoreStore();
    const reg = make(restore);
    const pty = reg.get('0');
    reg.snapshotForRestore();
    expect(restore.ids()).toEqual(['0']);
    pty.write('exit\r'); // the user typing `exit`, not a kill
    await exited(pty);
    expect(restore.ids()).toEqual([]);
  });

  it('SHUTDOWN keeps it — that exit is the server stopping, not a tab closing', async () => {
    const restore = memoryRestoreStore();
    const reg = make(restore);
    const pty = reg.get('0');
    reg.beginShutdown();
    reg.snapshotForRestore(true);
    pty.kill(); // what closing the server does to every shell
    await exited(pty);
    expect(restore.ids()).toEqual(['0']);
  });

  it('the snapshot writer skips a tab that is being killed', async () => {
    const restore = memoryRestoreStore();
    const reg = make(restore);
    const pty = reg.get('0');
    reg.kill('0'); // returns immediately; the shell dies up to 3s later
    // The 60s tick (or a shutdown) landing inside that window used to write the
    // snapshot straight back onto the id the kill had just forgotten.
    reg.snapshotForRestore();
    expect(restore.ids()).toEqual([]);
    await exited(pty);
  });

  it('creating a NON-terminal tab on a recycled id drops the stale snapshot', () => {
    const restore = memoryRestoreStore({ '0': snap('vim notes.md') });
    const reg = make(restore);
    expect(reg.createTab({ kind: 'editor' })).toBe('0');
    expect(restore.ids()).toEqual([]);
  });

  it('boot sweeps snapshots whose tab did not survive (the SIGKILL case)', () => {
    // A crash leaves snapshots for tabs that tabs.json never recorded. Nothing
    // can reattach to them, and id 7 is free for the taking.
    const restore = memoryRestoreStore({ '7': snap('htop'), '0': snap('tmux a') });
    const tabs = memoryTabsStore();
    tabs.save([{ id: '0', kind: 'terminal', name: 'work' }]);
    make(restore, tabs);
    expect(restore.ids()).toEqual(['0']);
  });

  it('a surviving tab keeps its snapshot across the boot sweep', () => {
    const restore = memoryRestoreStore({ '3': snap('tmux attach -t x') });
    const tabs = memoryTabsStore();
    tabs.save([{ id: '3', kind: 'terminal' }]);
    const reg = make(restore, tabs);
    expect(restore.ids()).toEqual(['3']);
    expect(reg.tabs().map((t) => t.id)).toContain('3');
  });
});
