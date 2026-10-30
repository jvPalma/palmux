import { describe, expect, it } from 'vitest';
import { closeKeyIntent } from './close-key';

const key = (over: Partial<KeyboardEvent> = {}) => ({
  key: 'w',
  code: 'KeyW',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe('closeKeyIntent', () => {
  it('closes the palmux tab on Ctrl+W outside a terminal', () => {
    for (const kind of ['review', 'editor', 'markdown', 'web', 'dashboard'] as const) {
      expect(closeKeyIntent(key({ ctrlKey: true }), kind)).toBe('closeTab');
    }
  });

  it('leaves Ctrl+W to the shell in a terminal', () => {
    expect(closeKeyIntent(key({ ctrlKey: true }), 'terminal')).toBe('shell');
  });

  it('closes the palmux tab on Cmd+W, in a terminal too', () => {
    expect(closeKeyIntent(key({ metaKey: true }), 'terminal')).toBe('closeTab');
    expect(closeKeyIntent(key({ metaKey: true }), 'review')).toBe('closeTab');
  });

  it('matches the layout character, not the physical key', () => {
    // AZERTY: the physical W key types z, and Ctrl+Z is undo.
    expect(closeKeyIntent(key({ ctrlKey: true, key: 'z' }), 'review')).toBeNull();
    // AZERTY's w sits on the physical Z key.
    expect(closeKeyIntent(key({ ctrlKey: true, code: 'KeyZ' }), 'review')).toBe('closeTab');
  });

  it('ignores every other chord', () => {
    expect(closeKeyIntent(key(), 'review')).toBeNull();
    expect(closeKeyIntent(key({ ctrlKey: true, shiftKey: true }), 'review')).toBeNull();
    expect(closeKeyIntent(key({ ctrlKey: true, altKey: true }), 'review')).toBeNull();
    expect(closeKeyIntent(key({ ctrlKey: true, metaKey: true }), 'review')).toBeNull();
    expect(closeKeyIntent(key({ ctrlKey: true, key: 'q', code: 'KeyQ' }), 'review')).toBeNull();
  });
});
