import { describe, expect, it } from 'vitest';
import { renderGroups, renderOpen, renderSettings, renderStatus, renderTabs } from './render';

const group = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  color: 'blue',
  ...over,
});

describe('renderTabs', () => {
  it('prints tabs in the order given, never sorted by id', () => {
    // Display order is decoupled from id (tab-reorder), so the registry's order is
    // the only one any window has ever shown. Sorting here would print an order
    // that has never existed.
    const out = renderTabs({
      tabs: [
        { id: '2', kind: 'terminal' },
        { id: '0', kind: 'terminal' },
      ],
      groups: [],
    });
    expect(out.split('\n').map((l) => l.split('  ')[0])).toEqual(['2', '0']);
  });

  it('indents a group header once and only once, over its members', () => {
    const out = renderTabs({
      tabs: [
        { id: '0', kind: 'terminal', groupId: 'gabcde' },
        { id: '1', kind: 'terminal', groupId: 'gabcde' },
        { id: '2', kind: 'terminal' },
      ],
      groups: [group('gabcde', { name: 'work' })],
    });
    expect(out).toBe(
      ['gabcde  work — 2 tabs', '  0  terminal', '  1  terminal', '2  terminal'].join('\n'),
    );
  });

  it('singularizes a one-tab group and names an unnamed one', () => {
    const out = renderTabs({
      tabs: [{ id: '0', kind: 'terminal', groupId: 'gabcde' }],
      groups: [group('gabcde')],
    });
    expect(out).toContain('(unnamed group) — 1 tab');
  });

  // A groupId whose group is gone (a stale tab) must not print a header with no
  // name and no way to tell it apart from a real one.
  it('does not invent a header for a group the payload does not carry', () => {
    const out = renderTabs({
      tabs: [{ id: '0', kind: 'terminal', groupId: 'gmissing' }],
      groups: [],
    });
    expect(out).toBe('0  terminal');
  });

  it('labels a tab by name, then title, then nothing at all', () => {
    // Not the kind: a fresh terminal has neither a name nor an OSC title yet, so
    // falling back to the kind printed it twice on every line — `0  terminal
    // terminal`. The kind already has its own column.
    const out = renderTabs({
      tabs: [
        { id: '0', kind: 'terminal', name: 'build' },
        { id: '1', kind: 'terminal', title: 'zsh' },
        { id: '2', kind: 'terminal' },
      ],
      groups: [],
    });
    expect(out.split('\n')).toEqual(['0  terminal  build', '1  terminal  zsh', '2  terminal']);
  });

  // The url is the only thing that tells two editor tabs apart; a terminal has no
  // url and would print a trailing blank.
  it('prints the url for non-terminal tabs only', () => {
    const out = renderTabs({
      tabs: [
        { id: '0', kind: 'editor', url: '/tmp/a.txt' },
        { id: '1', kind: 'terminal', url: 'ignored' },
      ],
      groups: [],
    });
    // An editor tab's url is the only thing that tells two of them apart, so it
    // stands in for the missing label rather than trailing an empty column.
    expect(out.split('\n')).toEqual(['0  editor  /tmp/a.txt', '1  terminal']);
  });

  it('says so when there is nothing', () => {
    expect(renderTabs({ tabs: [], groups: [] })).toBe('no tabs');
  });

  // The CLI and the server ship together but need not MATCH — a newer server is
  // the realistic case, and `undefined.map` at a prompt is not a failure anyone
  // can act on.
  it('refuses a shape it does not recognise instead of throwing', () => {
    for (const bad of [null, 'x', {}, { tabs: [] }, { tabs: [], groups: 'x' }]) {
      expect(renderTabs(bad)).toBe('unexpected response from the server');
    }
  });
});

describe('renderGroups', () => {
  it('lists members by id, and says so when a group is empty', () => {
    const out = renderGroups({
      tabs: [{ id: '0', kind: 'terminal', groupId: 'gabcde' }],
      groups: [group('gabcde', { name: 'work' }), group('gfghij')],
    });
    expect(out.split('\n')).toEqual([
      'gabcde  work  blue  [0]',
      'gfghij  (unnamed)  blue  [no members]',
    ]);
  });

  it('says so when there are none', () => {
    expect(renderGroups({ tabs: [], groups: [] })).toBe('no groups');
    expect(renderGroups(null)).toBe('unexpected response from the server');
  });
});

describe('renderStatus', () => {
  it('pads the labels into a column', () => {
    const out = renderStatus({ version: '2.0.0+abc', port: 44040, tabs: 3, windows: 2 });
    expect(out.split('\n').map((l) => l.trim().split(/\s+/))).toEqual([
      ['version', '2.0.0+abc'],
      ['port', '44040'],
      ['tabs', '3'],
      ['windows', '2'],
    ]);
  });

  it('refuses a partial payload rather than printing undefined', () => {
    expect(renderStatus({ version: '2.0.0', port: 44040 })).toBe(
      'unexpected response from the server',
    );
    expect(renderStatus(null)).toBe('unexpected response from the server');
  });
});

describe('renderOpen', () => {
  // `created: false` means the command MOVED to an editor tab already showing this
  // path. Saying "opened" there reads as a second buffer having appeared.
  it('distinguishes a new tab from one that was already showing the path', () => {
    expect(renderOpen({ id: '3', created: true }, '/tmp/a.txt')).toBe('opened tab 3: /tmp/a.txt');
    expect(renderOpen({ id: '3', created: false }, '/tmp/a.txt')).toBe(
      'showing tab 3: /tmp/a.txt',
    );
  });

  it('falls back to naming the path when the reply is unusable', () => {
    expect(renderOpen({ created: true }, '/tmp/a.txt')).toBe('opened /tmp/a.txt');
    expect(renderOpen(null, '/tmp/a.txt')).toBe('opened /tmp/a.txt');
    expect(renderOpen({ id: 'not-an-id', created: true }, '/a')).toBe('opened /a');
  });
});

describe('renderSettings', () => {
  // Opaque to the server and owned by the client, so printing the JSON is the
  // honest rendering — it stays correct as the client adds keys.
  it('prints the blob as indented JSON, whatever it holds', () => {
    expect(renderSettings({ themeId: 'mocha', nested: { a: 1 } })).toBe(
      ['{', '  "themeId": "mocha",', '  "nested": {', '    "a": 1', '  }', '}'].join('\n'),
    );
    expect(renderSettings({})).toBe('{}');
  });
});
