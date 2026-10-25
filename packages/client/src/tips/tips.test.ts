// The tips are prose, so nothing fails at runtime when one goes stale. These
// checks pin the two ways the drawer's tips have gone wrong: the redesign's
// gestures missing from the list, and wording from the old drawer (a header that
// switched four views, a ✕ cell on every row) surviving it.

import { describe, expect, it } from 'vitest';
import { TIPS } from './tips';

const tip = (title: string) => {
  const found = TIPS.find((t) => t.title === title);
  if (!found) throw new Error(`no tip titled "${title}"`);
  return found;
};

describe('tips', () => {
  it('has a unique, non-empty title and description on every tip', () => {
    const titles = TIPS.map((t) => t.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const t of TIPS) {
      expect(t.title.trim(), t.title).not.toBe('');
      expect(t.description.trim(), t.title).not.toBe('');
    }
  });

  describe('the mobile drawer', () => {
    it('explains long-press drag: reorder, join a group, leave a group', () => {
      const text = tip('Reorder and regroup in the drawer').description;
      expect(text).toMatch(/long-press/i);
      expect(text).toMatch(/reorder/i);
      expect(text).toMatch(/group header/i);
      expect(text).toContain('Drop here to ungroup');
      expect(text).toMatch(/nothing moves unless you hold/i);
    });

    it('explains the long-press menu as a release without moving', () => {
      const text = tip('Long-press a row for its menu').description;
      expect(text).toMatch(/let go without moving/i);
      expect(text).toMatch(/rename/i);
      expect(text).toMatch(/still asks first/i);
    });

    it('explains swipe-left close, including the confirm and how to hide it', () => {
      const text = tip('Swipe a row left to close it').description;
      expect(text).toMatch(/swipe a drawer row to the left/i);
      expect(text).toMatch(/still asks/i);
      expect(text).toMatch(/swipe right/i);
    });

    it('puts Settings at the top, beside the close button', () => {
      const text = tip('Settings at the top of the drawer').description;
      expect(text).toMatch(/top of the drawer/i);
      expect(text).toMatch(/close button/i);
    });

    it('describes the keyboard hold and the picker hold', () => {
      const text = tip('The drawer and the soft keyboard').description;
      expect(text).toMatch(/never dismisses the keyboard/i);
      expect(text).toMatch(/at most one resize/i);
      expect(text).toMatch(/until the file picker returns/i);
    });

    it('places the switcher above the footer and Settings out of it', () => {
      const text = tip('Sessions drawer').description;
      expect(text).toMatch(/switcher.*just above them/i);
      expect(text).toMatch(/Settings.*at the very top/i);
    });

    it('keeps no wording from the old drawer', () => {
      const mobile = TIPS.filter((t) => t.category === 'Mobile');
      for (const t of mobile) {
        expect(t.description, t.title).not.toMatch(/four views/i);
        expect(t.description, t.title).not.toMatch(/header switches/i);
        expect(t.description, t.title).not.toMatch(/✕ cell/);
      }
    });

    it('does not send mobile users to a ✕ the drawer rows no longer have', () => {
      // The strip's ✕ is real; a tip that mentions it must also name the swipe.
      for (const title of ['Workspaces', 'Files open as tabs']) {
        const text = tip(title).description;
        expect(text, title).toMatch(/swipe/i);
      }
    });
  });
});
