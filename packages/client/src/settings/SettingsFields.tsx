// ── Settings form rows ────────────────────────────────────────────────────────
//
// Just the fields — no dialog, no overlay, no Escape handling. TWO hosts render
// this: the desktop side DOCK, and on mobile the session drawer, where settings
// are drawer items rather than a modal stacked over the terminal. Keeping one
// field list is what stops those surfaces drifting apart. (There was a third —
// the desktop modal — retired once the dock reached parity; settings are now
// layout on both, never an overlay.)
//
// Settings are grouped into titled sections, and each section's rows sit in ONE
// card (`.set-card`) separated by hairlines. Every setting is an `.srow`: its
// label (with an optional SECOND LINE under it carrying the current value or the
// consequence) in a flexible column, and its control in a column of one fixed
// width shared by every row. Controls come from the kit: Switch for a toggle,
// Segmented for a two- or three-option choice, Select for a longer list, Input
// for a number or a URL, Button for an action. No native <select> is left — a
// native one cannot take the kit's trigger, chevron or popup, and a phone draws it
// as a full-screen picker. See settings-view.css.
//
// Theme is not a Select. It has twenty-odd profiles and a name cannot show
// whether a theme's red survives its own background, so the Theme row is a button
// that opens a BROWSER in place of the form (the `themes` sub-view, ThemeBrowser):
// a back stack of depth one, owned here unless a host lifts it. The drawer does,
// so its own back header can pop the sub-view before it leaves Settings. The
// sub-view is also where a theme is imported and where the app is told to follow
// the system's light/dark scheme (see ThemeSubView).
//
// The switch replaces the control that holds focus, so focus is moved across it
// rather than left to fall on the body. One rule: going in, focus lands on the
// first control the sub-view DRAWS. That is `‹ Settings` in the dock; the drawer
// hides that control (its header does the job), so there it is the mode switch,
// one Shift+Tab below the header. Coming out, focus returns to the Theme row
// that opened it. Focus is never taken from a text field outside the panel
// (see `carriesFocus`).
//
// The controls of that round trip (the Theme row, its label, every theme entry,
// `‹ Settings`) act on the POINTER (`pressMove`), not on a click. A real press
// focuses a button natively before its click runs, so in the drawer the switch
// found focus inside the panel, carried it into the list, and #mobile-kbd lost
// it: the soft keyboard went down. `pressMove` keeps #mobile-kbd, leaves a touch
// free to scroll the panel, and still answers Enter, Space and assistive tech
// through the click.
//
// Every row still reads and writes through the single `onChange` prop, so a host
// needs to know nothing about which control a setting happens to use.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import type {
  ClientSettings,
  CursorStyle,
  MobileModePref,
  ThemeMode,
  ThemeSlot,
  ThemeTarget,
} from './settings';
import { FONT_PRESETS, resolveThemeId, themeModeChange, themePick } from './settings';
import { allProfiles, type ColorProfile } from './themes';
import { ThemeBrowser } from './ThemeBrowser';
import { useSystemPrefersDark } from './useSystemPrefersDark';
import { reloadApp } from './app-reload';
import type { PwaInstallState } from './pwa-install';
import { onPwaInstallChange, promptPwaInstall, pwaInstallState } from './pwa-install';
import { Button, Collapsible, Input, Segmented, Select, Switch } from '../ui';
import type { SegmentedOption } from '../ui';
import { Icon } from '../ui/icons';
import { pressMove } from '../panes/press';
import './settings-view.css';

/** What the panel shows in place of its form. `null` is the form itself. */
export type SettingsSubView = 'themes' | null;

export interface SettingsFieldsProps {
  settings: ClientSettings;
  onChange: (partial: Partial<ClientSettings>) => void;
  /** Family names discovered under the server's ~/.fonts (registered as web fonts). */
  fontFamilies?: string[] | undefined;
  /** Open the keybindings editor (omit to hide the entry point). */
  onOpenKeybindings?: (() => void) | undefined;
  /** Shortcuts & tips. A Settings row rather than topbar chrome: the desktop
   *  action bar is gone, and of the three buttons it held this is the one
   *  nobody reaches for mid-session. */
  onOpenTips?: (() => void) | undefined;
  /** Import a theme from a URL/name (omit to hide the importer). `target` is what
   *  the import is FOR, captured now: the host applies the answer to it when it
   *  lands, however long that takes (see `themePick`). */
  onImportTheme?: ((source: string, target: ThemeTarget) => void) | undefined;
  /** True while an import is in flight — disables the Add button. */
  importingTheme?: boolean | undefined;
  /** Server build the client last saw, shown next to the reload control. */
  appVersion?: string | undefined;
  /** Reload the app, resolving `true` once it is proceeding and `false` when the
   *  host declined (a confirm the user cancelled). Hosts that know about work a
   *  reload would destroy pass this; without it the row reloads unconditionally. */
  onReloadApp?: (() => Promise<boolean>) | undefined;
  /** Open the raw config.json editor (omit to hide the row). Desktop dock only:
   *  the editor lives in the dock and the drawer has no room for it. */
  onEditConfig?: (() => void) | undefined;
  /** The Edit config.json row, for the host to hand focus back to as the editor
   *  closes: this form is a NEW one then, so nothing here remembers the row. */
  editConfigRef?: Ref<HTMLButtonElement> | undefined;
  /** Which sub-view is showing. Omit it and the panel keeps its own, starting on
   *  the form — a host that passes nothing gets exactly that. A host that has its
   *  own back control lifts the state so that control can pop the sub-view first. */
  subView?: SettingsSubView | undefined;
  onSubViewChange?: ((next: SettingsSubView) => void) | undefined;
}

/**
 * A settings group. A kit Collapsible, so the same component serves the dock,
 * the mobile drawer and the new-tab view — and so a fifteen-row form can be
 * folded down to the four groups you are not using. Its trigger is the kit's
 * section title (a small secondary-colour label); the rows sit in one card.
 *
 * The open state is per DEVICE (localStorage, keyed by title): which sections you
 * keep folded on a phone has nothing to do with a desktop, and it must never
 * reach the synced settings payload.
 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Collapsible
      title={title}
      storageKey={`palmux-settings-section-${title.toLowerCase()}`}
      defaultOpen
      className="settings-section"
      data-testid={`settings-section-${title.toLowerCase()}`}
    >
      <div className="set-card">{children}</div>
    </Collapsible>
  );
}

/**
 * One settings row. `htmlFor` is what pairs the label with the control, so a row
 * whose control has no id of its own (a Segmented is a group, not a field) gets
 * a plain span instead — an empty `for=` is worse than no label element at all.
 *
 * `onLabelPress` is for a control that acts on the pointer itself (`pressMove`).
 * Left to the browser, a press on the label would move focus and then forward a
 * click to the control, so the label acts on the pointer too; that cancels the
 * forwarded click, and the `for=` association (the control's name) stays.
 */
function Row({
  label,
  sub,
  note,
  htmlFor,
  onLabelPress,
  children,
}: {
  label: ReactNode;
  sub?: ReactNode;
  /** A hint too long for the label column: a line of its own under the row. */
  note?: ReactNode;
  htmlFor?: string | undefined;
  onLabelPress?: (() => void) | undefined;
  children: ReactNode;
}) {
  const text = (
    <>
      {label}
      {sub ? <span className="srow-sub">{sub}</span> : null}
    </>
  );
  return (
    <div className="srow">
      {htmlFor ? (
        <label
          className="srow-label"
          htmlFor={htmlFor}
          {...(onLabelPress ? pressMove(onLabelPress) : {})}
        >
          {text}
        </label>
      ) : (
        <span className="srow-label">{text}</span>
      )}
      <div className="srow-control">{children}</div>
      {note ? <div className="srow-note">{note}</div> : null}
    </div>
  );
}

/** A row whose control is a kit Switch. The switch carries the row's id, so the
 *  label's `for=` still activates it and the testid still names the setting. */
function ToggleRow({
  id,
  label,
  sub,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  sub?: ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <Row label={label} sub={sub} htmlFor={id}>
      <Switch id={id} checked={checked} onCheckedChange={onChange} data-testid={id} />
    </Row>
  );
}

/**
 * A row that opens somewhere else: the whole row is the button and a chevron sits
 * at the right edge of the control column, where a switch would. Not a Row: a
 * `<label>` and a `<div>` cannot be the one control, and a button inside a row
 * would make the label a dead zone around it.
 */
function LinkRow({
  label,
  onOpen,
  buttonRef,
  'data-testid': testId,
}: {
  label: string;
  onOpen: () => void;
  buttonRef?: Ref<HTMLButtonElement> | undefined;
  'data-testid': string;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="srow srow-link"
      onClick={onOpen}
      data-testid={testId}
    >
      <span className="srow-label">{label}</span>
      <span className="srow-control">
        <Icon name="chevron-right" size={12} />
      </span>
    </button>
  );
}

const MOBILE_OPTIONS: ReadonlyArray<SegmentedOption<MobileModePref>> = [
  { value: 'auto', label: 'Auto' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

const CURSOR_OPTIONS: ReadonlyArray<SegmentedOption<CursorStyle>> = [
  { value: 'block', label: 'Block' },
  { value: 'underline', label: 'Underline' },
  { value: 'bar', label: 'Bar' },
];

/** The reload a host gets when it supplies none: unconditional, as it always was. */
const reloadUnguarded = (): Promise<boolean> => {
  void reloadApp();
  return Promise.resolve(true);
};

/**
 * Reload onto the current build. Worth a row of its own: an installed PWA has
 * no reload button at all, and a plain refresh can replay a cached index.html
 * that still names the previous bundle. The sub-line is the build the client
 * last saw, which is the only way to tell a stale device from a broken fix.
 */
function ReloadRow({
  version,
  onReload = reloadUnguarded,
}: {
  version: string | undefined;
  onReload?: (() => Promise<boolean>) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  // Busy only once the reload is CONFIRMED. Setting it first left a cancelled
  // reload stuck on a disabled "Reloading…" with nothing reloading; a throw
  // resets it for the same reason, so the user can simply try again.
  const reload = () => {
    void onReload().then(setBusy, () => setBusy(false));
  };
  // The build string is the one hint that is a VALUE, not a sentence: it does not
  // wrap, it ends in an ellipsis and carries the whole of it as a tooltip.
  const build = version ? `build ${version}` : null;
  return (
    <Row
      label="Reload app"
      sub={
        build ? (
          <span className="srow-value" title={build}>
            {build}
          </span>
        ) : (
          'clears caches and service worker'
        )
      }
      htmlFor="set-reload"
    >
      <Button id="set-reload" data-testid="reload-app" disabled={busy} onClick={reload}>
        {busy ? 'Reloading…' : 'Reload'}
      </Button>
    </Row>
  );
}

const INSTALL_HINT: Record<PwaInstallState, string> = {
  available: 'add palmux to the home screen',
  installed: 'already installed',
  // Naming iOS is the useful half: there the install exists but only by hand.
  unavailable: 'iOS: Share → Add to Home Screen',
};

/**
 * Replay the browser's install offer. Sits under Reload app because both are
 * "the app itself", and because an installed PWA is what makes that row matter.
 */
function InstallRow() {
  const [state, setState] = useState<PwaInstallState>(pwaInstallState);
  useEffect(() => onPwaInstallChange(setState), []);
  return (
    <Row label="Install as app" sub={INSTALL_HINT[state]} htmlFor="set-install">
      <Button
        id="set-install"
        data-testid="install-pwa"
        disabled={state !== 'available'}
        onClick={() => void promptPwaInstall()}
      >
        {state === 'installed' ? 'Installed' : 'Install'}
      </Button>
    </Row>
  );
}

const NO_FONTS: string[] = [];

/**
 * Whether a sub-view switch should move focus. It should when focus fell on the
 * body, because the control that held it went out with the old content, and
 * when it sits on a host control outside the panel that drove the switch (the
 * drawer's header, by key). It must not when focus is in a text field outside
 * the panel: in the drawer that is #mobile-kbd, whose focus IS the soft
 * keyboard, and a pointer press on the header (`pressClick`) or on the round
 * trip's own controls (`pressMove`) is built to leave it there. A control inside
 * the panel means the new content already has it.
 */
const carriesFocus = (root: HTMLElement): boolean => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return true;
  if (root.contains(active)) return false;
  return !(active.isContentEditable || active.matches('input, textarea'));
};

/**
 * The first enabled button `root` actually draws. The check is needed because a
 * host can hide one of the sub-view's own controls with its stylesheet (the
 * drawer hides `‹ Settings`), and focus() on an element that is not drawn does
 * nothing, which would leave focus on the body. Buttons only: the sub-view holds
 * nothing else.
 */
const firstDrawnButton = (root: HTMLElement): HTMLElement | undefined =>
  [...root.querySelectorAll<HTMLElement>('button:not(:disabled)')].find((el) => {
    for (let node: HTMLElement | null = el; node && node !== root; node = node.parentElement) {
      if (getComputedStyle(node).display === 'none') return false;
    }
    return true;
  });

/** Built-in presets + discovered system fonts, deduped by CSS value. */
function fontOptionsFor(settings: ClientSettings, fontFamilies: string[]): Map<string, string> {
  const options = new Map<string, string>(); // value -> label
  for (const f of FONT_PRESETS) options.set(f.value, f.label);
  for (const fam of fontFamilies) {
    const value = `"${fam}", ui-monospace, monospace`;
    if (!options.has(value)) options.set(value, fam);
  }
  // The current value is always present so a custom stack still shows selected.
  // Not when it is empty: the kit Select cannot hold an option whose value is ''.
  if (settings.fontFamily && !options.has(settings.fontFamily)) {
    options.set(settings.fontFamily, settings.fontFamily);
  }
  return options;
}

/** A theme's display name; an id that is no longer registered shows as itself. */
const themeName = (profiles: ColorProfile[], id: string): string =>
  profiles.find((p) => p.id === id)?.name ?? id;

/**
 * The body of the `themes` sub-view: the mode switch, Import, the list. It is its
 * own component so the slot being edited is state that lives exactly as long as
 * the sub-view is open — leaving and coming back starts again on the scheme the
 * device is in, rather than on whichever slot was last touched.
 *
 * Three things are decided here because only here are the settings and the
 * scheme both in hand. What a pick WRITES depends on the mode (`themePick`); what
 * is MARKED current is the edited slot's pick in Match system and `themeId`
 * otherwise; and an import's target is captured at the moment it is submitted,
 * because the answer arrives later and the user may have moved on by then.
 */
function ThemeSubView({
  settings,
  profiles,
  onChange,
  onImportTheme,
  importingTheme,
}: {
  settings: ClientSettings;
  profiles: ColorProfile[];
  onChange: (partial: Partial<ClientSettings>) => void;
  onImportTheme: SettingsFieldsProps['onImportTheme'];
  importingTheme: boolean | undefined;
}) {
  const prefersDark = useSystemPrefersDark();
  const activeSlot: ThemeSlot = prefersDark ? 'dark' : 'light';
  const [slot, setSlot] = useState<ThemeSlot>(activeSlot);

  const { themeMode: mode } = settings;
  const target: ThemeTarget = mode === 'system' ? { mode, slot } : { mode };
  // A slot never chosen reads as the fixed theme, exactly as `resolveThemeId` has it.
  const slotPick = (which: ThemeSlot): string =>
    (which === 'dark' ? settings.themeDark : settings.themeLight) || settings.themeId;
  const value = mode === 'system' ? slotPick(slot) : settings.themeId;

  // A pick for the slot that is ON SCREEN is an explicit choice of what this device
  // shows, so it also moves the export (`themeId`: tmux, the Claude theme) — the same
  // as a Fixed pick. Only the passive paths (boot, reconnect, a broadcast) are kept
  // from writing it; a pick for the slot that is not active changes nothing visible
  // and leaves the export alone.
  const pick = (id: string): void => {
    const partial = themePick(settings, target, id);
    if (!partial) return;
    onChange(mode === 'system' && slot === activeSlot ? { ...partial, themeId: id } : partial);
  };
  const changeMode = (next: ThemeMode): void =>
    onChange(themeModeChange(settings, next, resolveThemeId(settings, prefersDark)));

  return (
    <ThemeBrowser
      profiles={profiles}
      value={value}
      onChange={pick}
      controls={{
        mode,
        onModeChange: changeMode,
        slot,
        onSlotChange: setSlot,
        activeSlot,
        slotNames: {
          dark: themeName(profiles, slotPick('dark')),
          light: themeName(profiles, slotPick('light')),
        },
        ...(onImportTheme ? { onImport: (source: string) => onImportTheme(source, target) } : {}),
        importing: importingTheme,
      }}
    />
  );
}

export function SettingsFields({
  settings,
  onChange,
  fontFamilies = NO_FONTS,
  onOpenKeybindings,
  onOpenTips,
  onImportTheme,
  importingTheme,
  appVersion,
  onReloadApp,
  onEditConfig,
  editConfigRef,
  subView: subViewProp,
  onSubViewChange,
}: SettingsFieldsProps) {
  // `null` is a real value (the form), so "controlled" is `!== undefined`.
  const [ownSubView, setOwnSubView] = useState<SettingsSubView>(null);
  const subView = subViewProp === undefined ? ownSubView : subViewProp;
  const setSubView = (next: SettingsSubView): void => {
    setOwnSubView(next);
    onSubViewChange?.(next);
  };

  // Keyed on the sub-view that is SHOWN, whoever changed it: the drawer's header
  // pops it through the controlled prop, with no call into this component. A
  // layout effect, so focus has moved before the new content paints. The first
  // render is not a switch and takes no focus.
  const rootRef = useRef<HTMLDivElement>(null);
  const themeRowRef = useRef<HTMLButtonElement>(null);
  const shownSubView = useRef(subView);
  useLayoutEffect(() => {
    if (shownSubView.current === subView) return;
    shownSubView.current = subView;
    const root = rootRef.current;
    if (!root || !carriesFocus(root)) return;
    (subView === 'themes' ? firstDrawnButton(root) : themeRowRef.current)?.focus();
  }, [subView]);

  const profiles = allProfiles();

  if (subView === 'themes') {
    return (
      <div className="settings-form settings-view" data-testid="settings-themes" ref={rootRef}>
        <div className="set-subhead">
          <Button
            variant="ghost"
            className="set-back"
            data-testid="settings-themes-back"
            {...pressMove(() => setSubView(null))}
          >
            <Icon name="chevron-left" size={14} />
            Settings
          </Button>
          <h2 className="set-subtitle">Theme</h2>
        </div>
        {/* Applies and persists on every pick, and the list stays: that is how a
            theme is judged — by trying two. */}
        <ThemeSubView
          settings={settings}
          profiles={profiles}
          onChange={onChange}
          onImportTheme={onImportTheme}
          importingTheme={importingTheme}
        />
      </div>
    );
  }

  const fontOptions = [...fontOptionsFor(settings, fontFamilies)].map(([value, label]) => ({
    value,
    label,
  }));
  // Match system names both slots; a slot never chosen reads as `themeId`, as the
  // resolver has it. The whole text is the title: the label is one line and ends
  // in an ellipsis in a 140px column.
  const themeLabel =
    settings.themeMode === 'system'
      ? `System · ${themeName(profiles, settings.themeDark || settings.themeId)} / ${themeName(
          profiles,
          settings.themeLight || settings.themeId,
        )}`
      : themeName(profiles, settings.themeId);
  const openThemes = (): void => setSubView('themes');

  return (
    <div className="settings-form settings-view" ref={rootRef}>
      <Section title="Appearance">
        <Row label="Theme" htmlFor="set-theme" onLabelPress={openThemes}>
          {/* Not a Select: an option list of NAMES cannot show you whether a
              theme's red survives its own background. The button opens a browser
              where each theme paints itself in its own palette. The name rides in
              the aria-label because a <label for> would otherwise be the whole
              accessible name and hide the current value. */}
          <Button
            ref={themeRowRef}
            id="set-theme"
            className="srow-theme"
            data-testid="set-theme"
            title={themeLabel}
            aria-label={`Theme: ${themeLabel}`}
            {...pressMove(openThemes)}
          >
            <span className="srow-theme-name">{themeLabel}</span>
            <Icon name="chevron-right" size={12} />
          </Button>
        </Row>

        <Row label="Font" htmlFor="set-font">
          <Select
            id="set-font"
            data-testid="set-font"
            aria-label="Font"
            value={settings.fontFamily}
            options={fontOptions}
            onChange={(fontFamily) => onChange({ fontFamily })}
          />
        </Row>

        <Row label="Font size" sub="terminal zoom, this device" htmlFor="set-size">
          <Input
            id="set-size"
            data-testid="set-size"
            className="srow-num"
            type="number"
            min={6}
            max={48}
            value={settings.fontSize}
            onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
          />
        </Row>

        <Row label="Cursor">
          <Segmented
            label="Cursor style"
            data-testid="set-cursor"
            value={settings.cursorStyle}
            options={CURSOR_OPTIONS}
            onValueChange={(cursorStyle) => onChange({ cursorStyle })}
          />
        </Row>

        <ToggleRow
          id="set-blink"
          label="Cursor blink"
          checked={settings.cursorBlink}
          onChange={(cursorBlink) => onChange({ cursorBlink })}
        />
      </Section>

      <Section title="Terminal">
        <Row label="Scrollback" sub="lines kept in memory" htmlFor="set-scrollback">
          <Input
            id="set-scrollback"
            data-testid="set-scrollback"
            className="srow-num"
            type="number"
            min={0}
            max={100000}
            step={500}
            value={settings.scrollback}
            onChange={(e) => onChange({ scrollback: Number(e.target.value) })}
          />
        </Row>

        <Row label="Mobile mode" sub="Auto = detect touch">
          <Segmented
            label="Mobile mode"
            data-testid="set-mobile"
            value={settings.mobileMode}
            options={MOBILE_OPTIONS}
            onValueChange={(mobileMode) => onChange({ mobileMode })}
          />
        </Row>

        <ToggleRow
          id="set-native-sel"
          label="Native touch selection"
          sub="browser handles + Copy callout"
          checked={settings.nativeTouchSelection}
          onChange={(nativeTouchSelection) => onChange({ nativeTouchSelection })}
        />

        <ToggleRow
          id="set-images"
          label="Inline images"
          sub="SIXEL + iTerm2 IIP"
          checked={settings.inlineImages}
          onChange={(inlineImages) => onChange({ inlineImages })}
        />
      </Section>

      <Section title="Keys">
        {onOpenKeybindings && (
          <Row label="Keybindings" htmlFor="set-keybindings">
            <Button id="set-keybindings" data-testid="open-keybindings" onClick={onOpenKeybindings}>
              Edit…
            </Button>
          </Row>
        )}
        {onOpenTips && (
          <Row label="Shortcuts & tips" htmlFor="set-tips">
            <Button id="set-tips" data-testid="open-tips" onClick={onOpenTips}>
              Open…
            </Button>
          </Row>
        )}
        <ToggleRow
          id="set-ctrlv"
          label="Ctrl+V pastes"
          sub="off: sent to the shell"
          checked={settings.ctrlVPaste}
          onChange={(ctrlVPaste) => onChange({ ctrlVPaste })}
        />
        <ToggleRow
          id="set-ctrlf"
          label="Ctrl+F opens search"
          sub="off: sent to the shell"
          checked={settings.ctrlFSearch}
          onChange={(ctrlFSearch) => onChange({ ctrlFSearch })}
        />
        <ToggleRow
          id="set-kbsel"
          label="Shift+Arrow keyboard selection"
          checked={settings.keyboardSelection}
          onChange={(keyboardSelection) => onChange({ keyboardSelection })}
        />
        <ToggleRow
          id="set-altdig"
          label="Alt+digit passes through to shell"
          checked={settings.altDigitPassthrough}
          onChange={(altDigitPassthrough) => onChange({ altDigitPassthrough })}
        />
        <ToggleRow
          id="set-vim"
          label="Vim input mode"
          sub="app text inputs, not the terminal"
          checked={settings.vimInputMode}
          onChange={(vimInputMode) => onChange({ vimInputMode })}
        />
      </Section>

      <Section title="App">
        <ReloadRow version={appVersion} onReload={onReloadApp} />
        <InstallRow />
        <ToggleRow
          id="set-latency"
          label="Latency overlay"
          sub="p50/p95, this device"
          checked={settings.latencyOverlay}
          onChange={(latencyOverlay) => onChange({ latencyOverlay })}
        />
        {onEditConfig && (
          <LinkRow
            label="Edit config.json"
            onOpen={onEditConfig}
            buttonRef={editConfigRef}
            data-testid="edit-config"
          />
        )}
      </Section>
    </div>
  );
}
