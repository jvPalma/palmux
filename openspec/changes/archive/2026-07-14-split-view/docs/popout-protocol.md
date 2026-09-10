# Pop-out window protocol

## Opening

```ts
window.open(`/${tabId}?popout=1`, `palmux-${tabId}`, 'popup,width=1000,height=640');
```

- The window NAME (`palmux-<id>`) dedupes: re-invoking pop-out for an already-popped tab focuses
  the existing window instead of spawning another.
- Tear-off (drag-release outside the viewport) adds `left/top = dragend.screenX/Y − half-size`,
  clamped on-screen. `dragend` coordinates and transient-activation are unreliable on some
  platforms — attempt first; if `window.open` returns null (blocked) OR the drop coordinates are
  unusable, show a toast with an explicit "Open" button (a real user gesture that always works).

## Popout client mode

- `popout=1` is read from `location.search` ONCE at boot into state. It must NOT be re-read later:
  `switchSession` uses `history.pushState(null, '', pathForSession(id))`, which drops the query.
- In popout mode the client: hides the tab strip, drawer, split and pop-out affordances; never
  reads or writes `palmux-split`; shows the "⇱ return to main" affordance.
- Killed-tab handling: if a `sessions` broadcast (control socket) drops this tab, show an ended
  state. Never auto-switch the popup to another session; never offer a reload path that would
  respawn a deliberately killed terminal.

## Return message

Popup → main:

```ts
window.opener?.postMessage(
  { type: 'palmux-popout-return', tabId }, // exact shape; nothing else
  location.origin, // NEVER '*'
);
window.close();
```

Main-window listener (lives beside the other App-level window listeners):

```ts
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return; // REQUIRED origin check
  const d = e.data as { type?: string; tabId?: string };
  if (d?.type !== 'palmux-popout-return' || typeof d.tabId !== 'string') return;
  switchSession(d.tabId); // no-op if the tab is gone
});
```

Rationale for the origin check: palmux is an authenticated terminal app; any window holding a
reference to it can postMessage. An unvalidated listener would let a foreign origin drive session
switches.

- `window.opener` null/closed (main window gone, or the popup was reopened from history): the
  return button renders disabled with a "main window closed" hint. Closing the popup is always
  safe — sessions live on the server.
