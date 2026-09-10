import { describe, expect, it } from 'vitest';
import { isTmuxSessionName, listTmuxSessions, tmuxAttachCommand } from './tmux';

describe('isTmuxSessionName', () => {
  it('accepts the shapes tmux sessions actually have', () => {
    for (const name of ['work', 'DB_BACKFILL-0', 'L1_ORCHESTRATOR_BILLING-0', 'my notes', '0']) {
      expect(isTmuxSessionName(name), name).toBe(true);
    }
  });

  it("rejects tmux's own target punctuation", () => {
    // `.` and `:` address a window/pane, so tmux forbids them in a session name.
    expect(isTmuxSessionName('a.b')).toBe(false);
    expect(isTmuxSessionName('a:b')).toBe(false);
  });

  it('rejects control characters — quoting cannot contain a newline', () => {
    // The name is typed into a shell. A CR ends the line inside quotes too,
    // exactly as session-restore documents for its captured argv.
    expect(isTmuxSessionName('a\nrm -rf /')).toBe(false);
    expect(isTmuxSessionName('a\rwhoami')).toBe(false);
    expect(isTmuxSessionName('a\x00b')).toBe(false);
    expect(isTmuxSessionName('a\x7f')).toBe(false);
  });

  it('rejects empty and absurd lengths', () => {
    expect(isTmuxSessionName('')).toBe(false);
    expect(isTmuxSessionName('x'.repeat(129))).toBe(false);
  });
});

describe('tmuxAttachCommand', () => {
  it('attaches-or-creates and steals the session', () => {
    // -A = attach or create (the session may have died since it was listed).
    // -D = detach the other client, because tmux sizes a window to its SMALLEST
    // client: a parallel attach from a phone shrinks the same session on a desktop.
    expect(tmuxAttachCommand('work')).toBe('tmux new-session -A -D -s work');
  });

  it('quotes a name that needs it', () => {
    expect(tmuxAttachCommand('my notes')).toBe("tmux new-session -A -D -s 'my notes'");
  });

  it('null means a fresh session tmux names itself', () => {
    expect(tmuxAttachCommand(null)).toBe('tmux new-session');
  });

  it('a name that survived validation still cannot inject', () => {
    // Belt and braces: isTmuxSessionName is the gate, quoting is the backstop.
    const cmd = tmuxAttachCommand('a$(whoami)`id`;ls');
    expect(cmd).toBe("tmux new-session -A -D -s 'a$(whoami)`id`;ls'");
  });
});

describe('listTmuxSessions', () => {
  it('returns a sorted, well-formed listing against the real tmux', async () => {
    const out = await listTmuxSessions();
    expect(typeof out.available).toBe('boolean');
    expect(Array.isArray(out.sessions)).toBe(true);
    for (const s of out.sessions) {
      expect(isTmuxSessionName(s.name), s.name).toBe(true);
      expect(typeof s.attached).toBe('boolean');
    }
    const names = out.sessions.map((s) => s.name);
    expect(names).toEqual([...names].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
  });

  // The bug this exists for: palmux runs as a systemd USER UNIT, whose PATH is
  // systemd's minimal default, not the login shell's. A Homebrew tmux is invisible
  // to it, and the feature reported "tmux is not installed" on a host with 26 live
  // sessions. The suite could not see it because a test runner inherits a shell PATH.
  it('finds tmux with the PATH a systemd unit actually gets', async () => {
    const real = process.env['PATH'];
    process.env['PATH'] = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    try {
      const stripped = await listTmuxSessions();
      const onPath = await (async () => {
        process.env['PATH'] = real ?? '';
        return listTmuxSessions();
      })();
      // Wherever tmux lives on this machine, the two answers must agree — that
      // is the whole claim. (Both false is a machine with no tmux at all.)
      expect(stripped.available).toBe(onPath.available);
    } finally {
      process.env['PATH'] = real ?? '';
    }
  });

  it('never throws and never reports a missing tmux as an empty server', async () => {
    // Whichever this machine is, exactly one of these holds — and neither is an
    // exception, because the chooser has to render either way.
    const out = await listTmuxSessions();
    if (!out.available) expect(out.sessions).toEqual([]);
  });
});
