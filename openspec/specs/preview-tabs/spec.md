# preview-tabs Specification

## Purpose
A file or diff you only glance at opens in a pane's preview tab, which the next glance replaces, so
browsing does not fill the strip. A preview becomes a normal tab as soon as you use it. The flag is
server state, so every window and device agrees on which tab is a preview. A replacement happens in
place: no window ever shows a tab arrive or leave because of it.

## Requirements

### Requirement: Preview opens land in the focused pane's preview tab

Opening a file from the Explorer, a file from the Source Control list, or an Open file action SHALL be a
preview open. Only `editor` tabs of a file and `review` tabs SHALL be previews. A preview open SHALL use the
focused pane's preview tab. In the mobile layer the window SHALL count as one pane. Every other way of opening
a tab SHALL open a pinned tab.

#### Scenario: Browsing ten files

- **WHEN** pane B is focused and the user opens ten files from the Explorer one after another
- **THEN** pane B holds one preview tab, showing the tenth file, and no other tab was added

#### Scenario: Each pane keeps its own preview

- **WHEN** pane A holds a preview of `a.ts`, the user focuses pane B and opens `b.ts` from the Explorer
- **THEN** pane B gets a preview tab of `b.ts` and pane A still shows its preview of `a.ts`

#### Scenario: A new terminal is never a preview

- **WHEN** the user creates a terminal from `+`
- **THEN** the new tab is pinned

### Requirement: The next preview open replaces the preview in place

A preview open of a target that already has a tab SHALL only show that tab, pinned or not. Otherwise, if the
focused pane holds a preview tab, the client SHALL replace it with one `replaceTab` message, whatever the two kinds
are. A replacement SHALL take the old tab's place in the strip and in its pane in a single step, so no window
SHALL show a tab being added or removed because of it, nor another tab of that pane in between.

#### Scenario: Same kind is updated in place

- **WHEN** the focused pane's preview tab shows `a.ts` and the user opens `b.ts` from the Explorer
- **THEN** the same tab id now shows `b.ts`, and no tab was created or closed

#### Scenario: Another kind is swapped in place

- **WHEN** the focused pane's preview tab is an editor in the third strip position and the user clicks a file in
  Source Control
- **THEN** a review preview of that file is in the third strip position, active in the same pane, the editor
  preview is gone, and at no render did the pane show another tab or the strip hold both tabs or neither

#### Scenario: Another window sees one swap

- **WHEN** window A replaces its editor preview with a review preview and window B shows the same tab in its strip
- **THEN** window B receives one `sessions` broadcast and its pill changes in place, with no tab removed or
  appended

#### Scenario: A pinned tab of the target is only shown

- **WHEN** `a.ts` is open as a pinned tab in pane A, pane B is focused with a preview of `b.ts`, and the user
  opens `a.ts` from the Explorer
- **THEN** pane A is focused and shows `a.ts`, and pane B's preview still shows `b.ts`

#### Scenario: Two opens before the first answer

- **WHEN** the focused pane has no preview tab and the user opens `a.ts` and then `b.ts` before the server
  answers the first create
- **THEN** one preview tab exists afterwards and it shows `b.ts`

#### Scenario: An unrelated broadcast before the answer

- **WHEN** another window renames a tab between this window's `replaceTab` and its answer
- **THEN** exactly one preview tab shows the requested file afterwards

#### Scenario: No answer

- **WHEN** a preview open gets no `tabCreated` answer within 5 seconds
- **THEN** a toast reads "Could not open `<name>`" and no tab changes

#### Scenario: A preview in a detached window

- **WHEN** a detached window's focused pane holds a preview and the user opens a file from that window's review
  with Open file
- **THEN** that detached window's preview shows the file, and no main window's preview changes

### Requirement: Which preview is replaced

When the focused pane holds several preview tabs (another window's preview joined it), the replaced one SHALL be
the pane's active tab if it is a preview, else its last preview tab in strip order. A tab with unsaved changes in
this window SHALL never be chosen.

#### Scenario: A pane holding two previews

- **WHEN** the focused pane holds a preview of `a.ts` and, as its active tab, a preview of `b.ts`, and the user
  opens `c.ts` from the Explorer
- **THEN** the `b.ts` preview now shows `c.ts` and the `a.ts` preview is unchanged

### Requirement: A replacement never overrides a pin

The server SHALL replace a tab only while it is still a preview and is shown by the sender's window. Otherwise it
SHALL create a new preview tab and leave the old one untouched, so a tab another window pinned a moment earlier,
by typing in it or on purpose, is never lost.

#### Scenario: Another window pinned it first

- **WHEN** window B pins window A's preview of `a.ts` by typing in it, and window A's `replaceTab` for `b.ts`
  reaches the server after that pin
- **THEN** `a.ts` stays open and pinned with its text, and a new preview tab shows `b.ts`

#### Scenario: The preview was closed by another window

- **WHEN** another window closes window A's preview tab just before window A's `replaceTab` arrives
- **THEN** a new preview tab shows the requested file in window A's focused pane

### Requirement: The preview flag is server state

A tab's preview state SHALL be the server field `TabMeta.preview`, present only as `true`. It SHALL be sent
in every `sessions` broadcast, persisted to `tabs.json` and restored at boot, so every window and device
shows the same tab as a preview. A server that supports it SHALL announce `previewTabs: true` in `ready`.

#### Scenario: Another device sees the preview

- **WHEN** a desktop opens `a.ts` from the Explorer as a preview
- **THEN** the phone's drawer lists that tab as a preview too

#### Scenario: A preview survives a restart

- **WHEN** the server restarts with a preview editor tab in `tabs.json`
- **THEN** the first `sessions` broadcast lists that tab with `preview: true`

#### Scenario: The server announces support

- **WHEN** a client connects to a server that supports preview tabs
- **THEN** its `ready` message carries `previewTabs: true`

### Requirement: Using a preview tab pins it

This requirement and the two after it are the canonical list of what pins a preview; the other capabilities
state only their own surface's trigger. A preview tab SHALL become pinned when it is used: a double-click on its
pill, a pointer double-click on the row that opened it, the first unsaved edit in it from any window, a save or
Ctrl+S, "Keep open", or opening the comment composer in a review preview. Pinning SHALL be one-way.

#### Scenario: Double-click on the pill

- **WHEN** the user double-clicks a preview tab's pill
- **THEN** the tab is pinned on every client and no rename field opens

#### Scenario: Double-click on the source row

- **WHEN** the user double-clicks a file in the Explorer
- **THEN** the file opens and its tab is pinned

#### Scenario: The first edit pins in every window

- **WHEN** the user types one character into a preview editor in window A
- **THEN** the tab is pinned, and a preview open in window B no longer replaces it

#### Scenario: Ctrl+S on an unchanged buffer

- **WHEN** the user presses Ctrl+S in a preview editor with no unsaved changes
- **THEN** the tab is pinned

#### Scenario: Keep open on a phone

- **WHEN** the user long-presses a preview row in the drawer and taps "Keep open"
- **THEN** the tab is pinned and the sheet closes

#### Scenario: Keep open on a desktop

- **WHEN** the user right-clicks a preview pill and chooses "Keep open"
- **THEN** the tab is pinned, and the menu of a pinned pill offers no "Keep open"

#### Scenario: The comment composer pins a review preview

- **WHEN** a single-file review preview is open and the user picks a line and opens the comment composer
- **THEN** the tab is pinned before anything is typed

### Requirement: Shaping or keeping a preview pins it

A preview tab SHALL also become pinned on a rename, a colour, creating a group from it or adding it to a group, a
move to another pane, and a pinned open of its target (`palmux open`).

#### Scenario: Colouring pins

- **WHEN** the user gives a preview tab a colour
- **THEN** the tab has that colour and is no longer a preview

#### Scenario: Joining a group pins

- **WHEN** the user chooses "New group from this tab" on a preview tab
- **THEN** the tab is in the new group and is no longer a preview

#### Scenario: Moving to another pane

- **WHEN** the user drops a preview tab on another pane's centre
- **THEN** the tab moves there and is pinned

#### Scenario: A pinned open pins

- **WHEN** `a.ts` is open as a preview and the user runs `palmux open a.ts`
- **THEN** that tab is shown and pinned, and no second tab is created

### Requirement: Some actions keep a preview a preview

Moving a preview tab to another window SHALL NOT pin it, and neither SHALL two keyboard activations of its row,
nor Reviewed, Unstage or next file in a review preview.

#### Scenario: Two Enter presses do not pin

- **WHEN** the user focuses a file row in the Explorer and presses Enter twice in quick succession
- **THEN** the file is open in a preview tab and the tab is still a preview

#### Scenario: Moving to another window keeps the preview

- **WHEN** the user opens a preview tab in a new window
- **THEN** the tab is in the detached window and is still a preview

#### Scenario: Reviewed keeps the preview

- **WHEN** a single-file review preview shows `a.ts` and the user taps Reviewed
- **THEN** the tab, still a preview, shows the next file

### Requirement: A preview tab is drawn as one

A preview tab's title SHALL be italic on the desktop pill and on the phone's drawer row, and nothing else
about the pill or row SHALL change. Its tooltip SHALL read "`<name>` — preview (double-click to keep open)"
and its accessible name SHALL end in ", preview". The phone's tab sheet and the desktop tab menu SHALL offer
"Keep open" only for a preview tab.

#### Scenario: Italic on the strip

- **WHEN** a pane's strip shows a preview tab and a pinned tab
- **THEN** only the preview tab's title is italic, and both pills have the same height, border and padding

#### Scenario: A screen reader hears it

- **WHEN** focus reaches a preview tab of `a.ts`
- **THEN** its accessible name is "a.ts, preview"

### Requirement: Without server support every open is pinned

A client whose server's `ready` does not carry `previewTabs` SHALL open every tab pinned, exactly as before,
and a Source Control file click SHALL open the group's continuous review at that file. Until the first
`ready` arrives the client SHALL behave as if the server had no support.

#### Scenario: An older server

- **WHEN** the client is newer than the server and the user opens three files from the Explorer
- **THEN** three pinned tabs exist, and no `preview` field and no `replaceTab` message is sent
