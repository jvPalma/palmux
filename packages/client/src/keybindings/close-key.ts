import type { TabKind } from '@palmux/shared';

// Ctrl+W (Cmd+W on a Mac) is the browser's "close tab", and in palmux that
// closes the WHOLE app, every terminal and unsaved buffer with it. So the chord
// is always claimed. What it then does depends on the active tab:
// - plain Ctrl+W in a terminal is the shell's werase (delete the word before the
//   cursor), so it goes on to xterm, which ignores `defaultPrevented`;
// - anywhere else (review, file, markdown, web, dashboard), and Cmd+W anywhere,
//   it closes the palmux TAB, with the same confirms as every other close.
// A browser honours the claim only where it lets a page see the chord: an
// installed app window does, a normal Chrome tab closes before the page is asked.
export type CloseKeyIntent = 'shell' | 'closeTab';

export function closeKeyIntent(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  activeKind: TabKind,
): CloseKeyIntent | null {
  // By the layout CHARACTER, as the browser and `chordFromEvent` resolve it: on
  // AZERTY the physical W key is Ctrl+Z (undo), which must stay undo.
  if (e.key.toLowerCase() !== 'w' || e.altKey || e.shiftKey || e.ctrlKey === e.metaKey) return null;
  if (e.ctrlKey && activeKind === 'terminal') return 'shell';
  return 'closeTab';
}
