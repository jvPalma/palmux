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

import { useId } from 'react';
import { hex, isLightBg, type ColorProfile } from './themes';
import { groupByBrightness, PREVIEW_LINES, type PreviewToken } from './theme-preview';
import { Icon } from '../ui/icons';
import { pressMove } from '../panes/press';
import './theme-browser.css';

export interface ThemeBrowserProps {
  profiles: ColorProfile[];
  value: string;
  onChange: (id: string) => void;
}

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

export const ThemeBrowser = ({ profiles, value, onChange }: ThemeBrowserProps) => {
  const { dark, light } = groupByBrightness(profiles, isLightBg);
  return (
    <div className="tb" data-testid="theme-browser">
      <Group label="Dark" profiles={dark} value={value} onChange={onChange} />
      <Group label="Light" profiles={light} value={value} onChange={onChange} />
    </div>
  );
};
