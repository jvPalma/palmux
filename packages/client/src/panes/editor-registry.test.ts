// Which editor the extra-keys bar talks to. Panes stay mounted while their tab
// exists, so several editors are alive at once and picking the wrong one would
// type into a file the user cannot see.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  focusEditor,
  focusedEditor,
  registerEditor,
  resetEditorRegistry,
  unregisterEditor,
  type EditorApi,
} from './editor-registry';

const api = (): EditorApi => ({ run: vi.fn(), type: vi.fn(), focus: vi.fn() });

beforeEach(() => resetEditorRegistry());

describe('editor registry', () => {
  it('has nothing focused before any editor mounts', () => {
    expect(focusedEditor()).toBeNull();
  });

  // On a phone the user may reach for the bar before ever touching the editor,
  // so a freshly mounted pane has to be reachable without an explicit focus.
  it('focuses the first editor to register, with no interaction', () => {
    const a = api();
    registerEditor('a', a);
    expect(focusedEditor()).toBe(a);
  });

  it('does not let a later mount steal focus from the one in use', () => {
    const a = api();
    const b = api();
    registerEditor('a', a);
    registerEditor('b', b);
    expect(focusedEditor()).toBe(a);
  });

  it('follows an explicit focus', () => {
    const a = api();
    const b = api();
    registerEditor('a', a);
    registerEditor('b', b);
    focusEditor('b');
    expect(focusedEditor()).toBe(b);
  });

  it('ignores a focus for an editor that is not registered', () => {
    const a = api();
    registerEditor('a', a);
    focusEditor('ghost');
    expect(focusedEditor()).toBe(a);
  });

  // Closing the focused tab must not leave the bar typing into a disposed
  // editor — `trigger` on one throws.
  it('hands focus to a survivor when the focused editor unmounts', () => {
    const a = api();
    const b = api();
    registerEditor('a', a);
    registerEditor('b', b);
    unregisterEditor('a');
    expect(focusedEditor()).toBe(b);
  });

  it('reports nothing once the last editor is gone', () => {
    registerEditor('a', api());
    unregisterEditor('a');
    expect(focusedEditor()).toBeNull();
  });

  it('leaves focus alone when an unfocused editor unmounts', () => {
    const a = api();
    registerEditor('a', a);
    registerEditor('b', api());
    unregisterEditor('b');
    expect(focusedEditor()).toBe(a);
  });
});
