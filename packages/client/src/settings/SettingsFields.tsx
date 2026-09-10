// ── Settings form rows ────────────────────────────────────────────────────────
//
// Just the fields — no dialog, no overlay, no Escape handling. TWO hosts render
// this: the desktop side DOCK, and on mobile the session drawer, where settings
// are drawer items rather than a modal stacked over the terminal. Keeping one
// field list is what stops those surfaces drifting apart. (There was a third —
// the desktop modal — retired once the dock reached parity; settings are now
// layout on both, never an overlay.)
//
// Every setting is an `.srow` —
// label at full text weight, an optional SECOND LINE under it carrying the
// current value or the consequence, control right-aligned, the whole row
// hover-tinted and rounded, and no rule line between rows. Controls come from
// the kit (block 01B's language): Switch for a toggle, Segmented for a two- or
// three-option choice, Input for a number or a URL, Button for an action. The
// two SELECTS stay native — Theme has eleven-plus profiles and Font has every
// family the server found, and a segmented control with a scroll bar is not a
// segmented control. See settings-view.css.
//
// Every row still reads and writes through the single `onChange` prop, so a host
// needs to know nothing about which control a setting happens to use.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ClientSettings, CursorStyle, MobileModePref, SidebarRailPref } from './settings';
import { FONT_PRESETS } from './settings';
import { allProfiles } from './themes';
import { ThemePicker } from './ThemePicker';
import { reloadApp } from './app-reload';
import type { PwaInstallState } from './pwa-install';
import { onPwaInstallChange, promptPwaInstall, pwaInstallState } from './pwa-install';
import { Button, Collapsible, Input, Segmented, Switch } from '../ui';
import type { SegmentedOption } from '../ui';
import './settings-view.css';

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
  /** Open the dictation history panel (omit to hide the entry point). */
  onOpenDictationHistory?: (() => void) | undefined;
  /** Import a theme from a URL/name (omit to hide the importer). */
  onImportTheme?: ((source: string) => void) | undefined;
  /** True while an import is in flight — disables the row. */
  importingTheme?: boolean | undefined;
  /** Server build the client last saw, shown next to the reload control. */
  appVersion?: string | undefined;
}

/**
 * A settings group. A kit Collapsible, so the same component serves the dock,
 * the mobile drawer and the new-tab view — and so a fifteen-row form can be
 * folded down to the four groups you are not using. Its trigger is the
 * `.dock-grp` caption (dim, uppercase, wide tracking).
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
      {children}
    </Collapsible>
  );
}

/**
 * One settings row. `htmlFor` is what pairs the label with the control, so a row
 * whose control has no id of its own (a Segmented is a group, not a field) gets
 * a plain span instead — an empty `for=` is worse than no label element at all.
 */
function Row({
  label,
  sub,
  htmlFor,
  stacked = false,
  children,
}: {
  label: ReactNode;
  sub?: ReactNode;
  htmlFor?: string | undefined;
  stacked?: boolean | undefined;
  children: ReactNode;
}) {
  const text = (
    <>
      {label}
      {sub ? <span className="srow-sub">{sub}</span> : null}
    </>
  );
  return (
    <div className={stacked ? 'srow srow-stacked' : 'srow'}>
      {htmlFor ? (
        <label className="srow-label" htmlFor={htmlFor}>
          {text}
        </label>
      ) : (
        <span className="srow-label">{text}</span>
      )}
      <div className="srow-control">{children}</div>
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

const RAIL_OPTIONS: ReadonlyArray<SegmentedOption<SidebarRailPref>> = [
  { value: 'always', label: 'Always' },
  { value: 'hidden', label: 'Hidden' },
];

/**
 * Paste-a-theme row. Kept local to the settings form because it owns one piece
 * of transient text state; the outcome arrives asynchronously as a toast, so
 * the field just clears itself on submit. Stacked, not side-by-side: the value
 * is a long URL or install command and a 55%-wide input truncated it to noise.
 */
function ThemeImportRow({
  onImport,
  busy,
}: {
  onImport: (source: string) => void;
  busy: boolean | undefined;
}) {
  const [source, setSource] = useState('');
  const submit = (): void => {
    const value = source.trim();
    if (!value || busy) return;
    onImport(value);
    setSource('');
  };
  return (
    <Row label="Import theme" htmlFor="set-theme-import" stacked>
      <Input
        id="set-theme-import"
        data-testid="set-theme-import"
        value={source}
        placeholder="Gogh name, URL, or install command"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => setSource(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      <Button data-testid="set-theme-import-add" onClick={submit} disabled={busy || !source.trim()}>
        {busy ? '…' : 'Add'}
      </Button>
    </Row>
  );
}

/**
 * Reload onto the current build. Worth a row of its own: an installed PWA has
 * no reload button at all, and a plain refresh can replay a cached index.html
 * that still names the previous bundle. The sub-line is the build the client
 * last saw, which is the only way to tell a stale device from a broken fix.
 */
function ReloadRow({ version }: { version: string | undefined }) {
  const [busy, setBusy] = useState(false);
  return (
    <Row
      label="Reload app"
      sub={version ? `build ${version}` : 'clears caches and service worker'}
      htmlFor="set-reload"
    >
      <Button
        id="set-reload"
        data-testid="reload-app"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void reloadApp();
        }}
      >
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

/** Built-in presets + discovered system fonts, deduped by CSS value. */
function fontOptionsFor(settings: ClientSettings, fontFamilies: string[]): Map<string, string> {
  const options = new Map<string, string>(); // value -> label
  for (const f of FONT_PRESETS) options.set(f.value, f.label);
  for (const fam of fontFamilies) {
    const value = `"${fam}", ui-monospace, monospace`;
    if (!options.has(value)) options.set(value, fam);
  }
  // The current value is always present so a custom stack still shows selected.
  if (!options.has(settings.fontFamily)) options.set(settings.fontFamily, settings.fontFamily);
  return options;
}

export function SettingsFields({
  settings,
  onChange,
  fontFamilies = NO_FONTS,
  onOpenKeybindings,
  onOpenTips,
  onOpenDictationHistory,
  onImportTheme,
  importingTheme,
  appVersion,
}: SettingsFieldsProps) {
  const fontOptions = fontOptionsFor(settings, fontFamilies);

  return (
    <div className="settings-form settings-view">
      <Section title="Appearance">
        <Row label="Theme" htmlFor="set-theme">
          {/* Not a <select>: an option list of NAMES cannot show you whether a
              theme's red survives its own background. Each option paints itself
              in its own palette — see ThemePicker. */}
          <ThemePicker
            id="set-theme"
            profiles={allProfiles()}
            value={settings.themeId}
            onChange={(themeId) => onChange({ themeId })}
          />
        </Row>

        {onImportTheme && <ThemeImportRow onImport={onImportTheme} busy={importingTheme} />}

        <Row label="Font" htmlFor="set-font">
          <select
            id="set-font"
            className="srow-select"
            data-testid="set-font"
            value={settings.fontFamily}
            onChange={(e) => onChange({ fontFamily: e.target.value })}
          >
            {[...fontOptions.entries()].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
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
        {/* Per-device, like font size and mobile mode: `always` is right on a
            desktop and wrong on a phone, so this must never reach the synced
            payload (see SYNCED_KEYS). Hidden entirely on mobile, where the
            drawer is the panel container and there is no rail to show. */}
        <Row
          label="Sidebar rail"
          // Naming what disappears, not just "panels": the rail is the only
          // POINTER route to Settings, Files, Dictation, the new-tab chooser AND
          // the Upload/Download actions, since the desktop action cluster is
          // gone. Every one of them has a keybinding and sits in the command
          // palette, which is what makes hiding the rail recoverable at all.
          sub={
            settings.sidebarRail === 'always'
              ? 'this device only · hiding it leaves keybindings and the command palette as the only route to settings, files, dictation, upload and download'
              : 'this device only · settings, upload and download are reachable from the command palette'
          }
        >
          <Segmented
            label="Sidebar rail"
            data-testid="set-sidebar-rail"
            value={settings.sidebarRail}
            options={RAIL_OPTIONS}
            onValueChange={(sidebarRail) => onChange({ sidebarRail })}
          />
        </Row>
        {onOpenDictationHistory && (
          <Row label="Dictation" htmlFor="set-dictation">
            <Button
              id="set-dictation"
              data-testid="open-dictation-history"
              onClick={onOpenDictationHistory}
            >
              History…
            </Button>
          </Row>
        )}
        <ReloadRow version={appVersion} />
        <InstallRow />
        <ToggleRow
          id="set-latency"
          label="Latency overlay"
          sub="p50/p95, this device"
          checked={settings.latencyOverlay}
          onChange={(latencyOverlay) => onChange({ latencyOverlay })}
        />
      </Section>
    </div>
  );
}
