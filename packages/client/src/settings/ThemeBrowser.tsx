// ── Theme browser ─────────────────────────────────────────────────────────────
//
// The list a theme is chosen from, drawn inside the settings panel itself. It
// replaced a Radix Select popup: a popup over a 300px dock was the thing the owner
// asked to get rid of ("sem sair daquela janela"), and a list that is part of the
// panel scrolls with it, works the same in the dock and the mobile drawer, and
// never has to be positioned against a trigger.
//
// A theme is not its name, and every entry here paints itself in its own palette:
// the theme's background, its foreground for the title, its cursor colour as a
// block at the end of the line, and two lines of fake shell using a spread of its
// sixteen ANSI colours. A grid of colour chips says a palette is colourful; a
// prompt and an error line say whether you can READ it — whether the red survives
// its own background, whether the comment grey is still there. You choose by
// looking at the thing you are choosing.
//
// Picking an entry applies it and leaves the list open, so another can be tried;
// the host owns the back stack (see SettingsFields' `subView`). Entries are plain
// buttons rather than a listbox: a listbox promises arrow-key roving, and the
// popup that supplied it is gone. The current entry says so with `aria-current`.
//
// An entry picks on the pointer's release (`pressMove`), not on a click: in the
// mobile drawer a press that focused the button natively took focus from
// #mobile-kbd and dismissed the soft keyboard, and this list scrolls, so a touch
// that moves must stay a scroll and pick nothing.
//
// This is the whole theme sub-view, not just the list. With `controls` it opens on
// the mode switch (Fixed | Match system, and in Match system which scheme a tap
// fills), then the Import section, then the Dark / Light groups: importing a theme
// is the same errand as choosing one, and it used to sit in the form's Appearance
// card, two screens away from the list its result appears in. The browser holds no
// selection state of its own — what is current, and what a pick means, belong to
// the host (SettingsFields), which knows the settings.

import { useId, useState } from 'react';
import { hex, isLightBg, type ColorProfile } from './themes';
import type { ThemeMode, ThemeSlot } from './settings';
import { groupByBrightness, PREVIEW_LINES, type PreviewToken } from './theme-preview';
import { Button, Input, Segmented } from '../ui';
import type { SegmentedOption } from '../ui';
import { Icon } from '../ui/icons';
import { pressMove } from '../panes/press';
import './theme-browser.css';

/** The controls above the list. Omit them and the browser is the bare list. */
export interface ThemeBrowserControls {
  mode: ThemeMode;
  onModeChange: (mode: ThemeMode) => void;
  /** Match system: the scheme a tap fills ("For dark" / "For light"). */
  slot: ThemeSlot;
  onSlotChange: (slot: ThemeSlot) => void;
  /** The scheme this device is in right now: a pick for it shows at once. */
  activeSlot: ThemeSlot;
  /** The name of each slot's current pick, for the note under the slot picker. */
  slotNames: Record<ThemeSlot, string>;
  /** Import a theme from a URL/name/command. Omit to hide the Import section. */
  onImport?: ((source: string) => void) | undefined;
  /** True while an import is in flight. */
  importing?: boolean | undefined;
}

export interface ThemeBrowserProps {
  profiles: ColorProfile[];
  /** The id marked current: the fixed pick, or in Match system the edited slot's. */
  value: string;
  onChange: (id: string) => void;
  controls?: ThemeBrowserControls | undefined;
}

const MODE_OPTIONS: ReadonlyArray<SegmentedOption<ThemeMode>> = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'system', label: 'Match system' },
];

const SLOT_OPTIONS: ReadonlyArray<SegmentedOption<ThemeSlot>> = [
  { value: 'dark', label: 'For dark' },
  { value: 'light', label: 'For light' },
];

/** The colour a token paints in, resolved against one profile. */
const colorOf = (p: ColorProfile, token: PreviewToken): string =>
  token.slot === 'fg' ? hex(p.fg) : hex(p.ansi16[token.slot] ?? p.fg);

/** One theme rendered in its own palette — the entry's whole body. */
const Swatch = ({ profile }: { profile: ColorProfile }) => (
  <div
    className="tb-swatch"
    style={{ background: hex(profile.bg), color: hex(profile.fg) }}
    data-testid={`theme-swatch-${profile.id}`}
  >
    <div className="tb-swatch-title">
      <span className="tb-swatch-name">{profile.name}</span>
      {/* A block cursor where a terminal would leave one. It uses the theme's
          explicit cursor colour when it has one, because that is a colour a
          palette can get wrong on its own and nothing else here shows it. */}
      <span
        className="tb-swatch-cursor"
        style={{ background: hex(profile.cursor ?? profile.fg) }}
        aria-hidden="true"
      />
    </div>
    {PREVIEW_LINES.map((line, i) => (
      <div className="tb-swatch-line" key={i} aria-hidden="true">
        {line.map((token, j) => (
          <span
            key={j}
            style={{
              color: colorOf(profile, token),
              ...(token.dim ? { opacity: 0.85 } : {}),
            }}
          >
            {token.text}
          </span>
        ))}
      </div>
    ))}
  </div>
);

interface GroupProps {
  label: string;
  profiles: ColorProfile[];
  value: string;
  onChange: (id: string) => void;
}

const Group = ({ label, profiles, value, onChange }: GroupProps) => {
  const labelId = useId();
  if (profiles.length === 0) return null;
  return (
    <div className="tb-group" role="group" aria-labelledby={labelId}>
      <div className="tb-group-label" id={labelId}>
        {label}
      </div>
      {profiles.map((p) => {
        const current = p.id === value;
        return (
          <button
            type="button"
            className="tb-item"
            key={p.id}
            data-state={current ? 'checked' : 'unchecked'}
            aria-current={current ? 'true' : undefined}
            data-testid={`theme-opt-${p.id}`}
            {...pressMove(() => onChange(p.id))}
          >
            <Swatch profile={p} />
            {current && (
              <span className="tb-check" aria-hidden="true">
                <Icon name="check" size={12} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};

/**
 * Paste-a-theme field. It owns one piece of transient text; the outcome arrives
 * asynchronously as a toast, so the field clears itself on submit. A long URL or
 * install command does not fit a 140px control column, which is why this is a
 * full-width line of its own rather than a settings row.
 */
const ThemeImport = ({
  onImport,
  busy,
}: {
  onImport: (source: string) => void;
  busy: boolean | undefined;
}) => {
  const labelId = useId();
  const [source, setSource] = useState('');
  const submit = (): void => {
    const value = source.trim();
    if (!value || busy) return;
    onImport(value);
    setSource('');
  };
  return (
    <div className="tb-group" role="group" aria-labelledby={labelId}>
      <div className="tb-group-label" id={labelId}>
        Import
      </div>
      <div className="tb-import">
        <Input
          id="set-theme-import"
          data-testid="set-theme-import"
          aria-label="Import a theme"
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
        <Button
          data-testid="set-theme-import-add"
          onClick={submit}
          disabled={busy || !source.trim()}
        >
          {busy ? '…' : 'Add'}
        </Button>
      </div>
    </div>
  );
};

const ModeControls = ({ controls }: { controls: ThemeBrowserControls }) => {
  const { mode, slot, activeSlot, slotNames } = controls;
  return (
    <div className="tb-mode">
      <Segmented
        label="Theme mode"
        data-testid="set-theme-mode"
        value={mode}
        options={MODE_OPTIONS}
        onValueChange={controls.onModeChange}
      />
      {mode === 'system' && (
        <>
          <Segmented
            label="Theme slot"
            data-testid="set-theme-slot"
            value={slot}
            options={SLOT_OPTIONS}
            onValueChange={controls.onSlotChange}
          />
          <p className="tb-note" data-testid="theme-slots-note">
            Dark: {slotNames.dark} · Light: {slotNames.light}
            {slot !== activeSlot && ` Shows when the system turns ${slot}.`}
          </p>
        </>
      )}
    </div>
  );
};

export const ThemeBrowser = ({ profiles, value, onChange, controls }: ThemeBrowserProps) => {
  const { dark, light } = groupByBrightness(profiles, isLightBg);
  return (
    <div className="tb" data-testid="theme-browser">
      {controls && <ModeControls controls={controls} />}
      {controls?.onImport && <ThemeImport onImport={controls.onImport} busy={controls.importing} />}
      <Group label="Dark" profiles={dark} value={value} onChange={onChange} />
      <Group label="Light" profiles={light} value={value} onChange={onChange} />
    </div>
  );
};
