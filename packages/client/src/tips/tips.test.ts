// The tips are prose, so nothing fails at runtime when one goes stale. These
// checks pin the two ways the drawer's tips have gone wrong: the redesign's
// gestures missing from the list, and wording from the old drawer (a header that
// switched four views, a ✕ cell on every row) surviving it.

import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS, formatChord } from '../keybindings/keybindings';
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

    it('puts Settings at the right end of the top row, where no close button is', () => {
      const text = tip('Settings at the top of the drawer').description;
      expect(text).toMatch(/top of the drawer/i);
      expect(text).toMatch(/right end/i);
      expect(text).not.toMatch(/close button|✕/i);
    });

    it('describes the keyboard hold and the picker hold', () => {
      const text = tip('The drawer and the soft keyboard').description;
      expect(text).toMatch(/never dismisses the keyboard/i);
      expect(text).toMatch(/at most one resize/i);
      expect(text).toMatch(/until the file picker returns/i);
    });

    it('puts the four-icon switcher and the gear at its right end in one row at the top', () => {
      const text = tip('Sessions drawer').description;
      expect(text).toMatch(/at the very top is one row/i);
      expect(text).toMatch(
        /four-icon switcher \(Sessions, Explorer, Source Control, Dictation\) with the Settings gear at its right end/i,
      );
      expect(text).not.toMatch(/close button|✕/i);
      expect(text).not.toMatch(/three-icon/i);
      expect(text).not.toMatch(/just above them/i);
    });

    it('names the ways out of a drawer that has no close button', () => {
      const text = tip('Sessions drawer').description;
      expect(text).toMatch(/tap the strip/i);
      expect(text).toMatch(/every footer action close the drawer/i);
      expect(text).toMatch(/Escape/);
    });

    it('says the drawer covers about three quarters of the screen, the rest being the strip', () => {
      const text = tip('Sessions drawer').description;
      expect(text).toMatch(/about three quarters of the screen/i);
      expect(text).not.toMatch(/covers the screen except/i);
    });

    it('says a bar with the drawer swipe is always present, the review bar on a review', () => {
      const text = tip('Sessions drawer').description;
      expect(text).toMatch(/a bar with the drawer swipe is always there/i);
      expect(text).toMatch(/review bar/i);
      expect(text).not.toMatch(/extra-keys bar is always there/i);
    });

    it('names the switcher’s three other views beside the gear', () => {
      expect(tip('Settings at the top of the drawer').description).toMatch(
        /Explorer, Source Control and Dictation/,
      );
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

  describe('windows', () => {
    it('says a new window takes the tab and gives it back when it closes', () => {
      const text = tip('Open in a new window').description;
      expect(text).toMatch(/leaves the main window/i);
      expect(text).toMatch(/come back to the main window, still running/i);
      expect(text).toMatch(/Move to main window/);
    });

    it('says a tab drags onto a strip, a pane’s middle or a pane’s edge, and what will not move', () => {
      const text = tip('Drag tabs between windows').description;
      expect(text).toMatch(/tab strip/i);
      expect(text).toMatch(/middle/i);
      expect(text).toMatch(/edge/i);
      expect(text).toMatch(/unsaved changes will not move by drag/i);
    });

    it('keeps no wording from the old pop-out', () => {
      for (const t of TIPS) {
        expect(t.description, t.title).not.toMatch(
          /return-to-main|popped window|takes the session over/i,
        );
      }
      expect(TIPS.some((t) => t.title === 'Pop out to a window')).toBe(false);
    });
  });

  describe('Source Control', () => {
    const text = () => tip('Source Control').description;

    it('says where to open it, and that it starts with no project', () => {
      expect(tip('Source Control').category).toBe('Side panel');
      expect(text()).toMatch(/branch icon on the rail/i);
      expect(text()).toMatch(/between Explorer and Dictation/i);
      expect(text()).toMatch(/starts empty/i);
      expect(text()).toMatch(/Add project/);
    });

    it('names the three groups and which one comes first', () => {
      expect(text()).toMatch(/Merge Changes.*shown first.*Staged Changes and Changes/i);
    });

    it('explains what is shared and what is per device', () => {
      expect(text()).toMatch(/shared by every device/i);
      expect(text()).toMatch(/its own choice/i);
    });

    it('says when it reads and when it does not', () => {
      expect(text()).toMatch(/about once a second/i);
      expect(text()).toMatch(/nothing is read/i);
    });

    it('describes the tree as the default, how to fold it, and the switch to the list', () => {
      expect(text()).toMatch(/each a folder tree/i);
      expect(text()).not.toMatch(/each file with its folder/i);
      const t = tip('Changed files as a tree');
      expect(t.category).toBe('Side panel');
      expect(t.description).toMatch(/only one other folder shares its row/i);
      expect(t.description).toMatch(/Enter or Space on it, to collapse or expand/i);
      expect(t.description).toMatch(
        /remembers which folders are closed, for each project and group/i,
      );
      expect(t.description).toMatch(/ArrowRight opens a closed folder/);
      expect(t.description).toMatch(
        /ArrowLeft closes an open one or moves to the folder that holds/,
      );
      expect(t.description).toMatch(/View as list.*project bar.*flat list.*View as tree/);
    });

    it('is one of the side dock’s panels, and the dock tip offers no way to hide the rail', () => {
      const dock = tip('The side dock').description;
      expect(dock).toMatch(/Files, Source Control, Dictation and Settings/);
      expect(dock).toMatch(/always there/i);
      // The Sidebar rail row is gone: the rail is always drawn on desktop.
      expect(dock).not.toMatch(/Side rail|hides the rail/i);
    });
  });

  describe('Review', () => {
    it('shows the live chord of every review key it names', () => {
      for (const [title, action, chord] of [
        ['Open Source Control', 'openSourceControl', 'Ctrl+Alt+G'],
        ['Next change', 'scmNextChange', 'Ctrl+Alt+J'],
        ['Next file', 'scmNextFile', 'Ctrl+Alt+N'],
        ['Reviewed', 'scmReviewed', 'Ctrl+Alt+Enter'],
      ] as const) {
        expect(tip(title).category, title).toBe('Review');
        expect(tip(title).action, title).toBe(action);
        expect(formatChord(DEFAULT_BINDINGS[action]), title).toBe(chord);
      }
    });

    it('says Reviewed stages what was shown, moves on, and can be undone', () => {
      const text = tip('Reviewed').description;
      expect(text).toMatch(/exactly as you saw it/i);
      expect(text).toMatch(/next file/i);
      expect(text).toMatch(/Undo for six seconds/i);
      expect(text).toMatch(/unstages it/i);
      expect(text).toMatch(/cannot be reviewed from here/i);
    });

    it('says how to move by change, across files, and by file', () => {
      expect(tip('Next change').description).toMatch(/next file’s first/i);
      expect(tip('Next change').description).toMatch(/Shift/);
      expect(tip('Next file').description).toMatch(/Shift/);
    });

    it('explains picking lines on desktop and on a phone, and what survives', () => {
      const text = tip('Comment on lines').description;
      expect(text).toMatch(/drag/i);
      expect(text).toMatch(/shift-click/i);
      expect(text).toMatch(/tap one number, then tap the last line/i);
      expect(text).toMatch(/draft survives scrolling/i);
      expect(text).toMatch(/outdated/i);
      expect(text).toMatch(/Copy comments/);
    });

    it('says a second Reviewed keeps the first one’s Undo', () => {
      const text = tip('Reviewed').description;
      expect(text).toMatch(/second Reviewed inside those six seconds/i);
      expect(text).toMatch(/Staged 2 files/);
      expect(text).toMatch(/newest first/i);
      expect(text).toMatch(/stops/i);
    });

    it('explains the keyboard route to line numbers, the not-shown mark and the orphaned edit', () => {
      const text = tip('Comment on lines').description;
      expect(text).toMatch(/Tab to a line number and press Enter or Space/i);
      expect(text).toMatch(/Shift\+Enter or Shift\+Space to widen/i);
      expect(text).toMatch(/too large or converted/i);
      expect(text).toMatch(/not shown/i);
      expect(text).toMatch(/Save as new and Discard/);
      expect(text).toMatch(/marking the outdated and the not shown ones/i);
    });

    it('explains the review bar on a phone: the buttons, the swipes, and that a swipe presses nothing', () => {
      const t = tip('The review bar');
      expect(t.category).toBe('Mobile');
      expect(t.description).toMatch(/takes the extra-keys bar’s place/i);
      expect(t.description).toMatch(/no terminal keys/i);
      expect(t.description).toMatch(/Files opens the drawer on Source Control/);
      expect(t.description).toMatch(/previous and next file/i);
      expect(t.description).toMatch(/Reviewed.*Unstage in a Staged review/i);
      expect(t.description).toMatch(/RIGHT→LEFT.*open the drawer/i);
      expect(t.description).toMatch(/LEFT→RIGHT.*back to the tab you opened the review from/i);
      expect(t.description).toMatch(/first terminal/i);
      expect(t.description).toMatch(
        /swipe that starts on Reviewed opens the drawer and stages nothing/i,
      );
    });

    it('says on a phone Source Control is the drawer’s branch icon, and choosing a file closes it', () => {
      const text = tip('Source Control').description;
      expect(text).toMatch(/branch icon in the drawer's switcher/i);
      expect(text).toMatch(/closes the drawer/i);
    });

    it('explains why Source Control is not on VS Code’s chord: that one is Copy last output here', () => {
      expect(tip('Open Source Control').description).toMatch(/Copy last output/);
      expect(formatChord(DEFAULT_BINDINGS.copyLastOutput)).toBe('Ctrl+Shift+G');
    });
  });
});
