// ── Theme picker ──────────────────────────────────────────────────────────────
//
// The native <select> this replaces could only ever show a list of NAMES, and a
// theme is not its name. Every option here paints itself in its own palette: the
// theme's background, its foreground for the title, its cursor colour as a block
// at the end of the line, and two lines of fake shell using a spread of its
// sixteen ANSI colours.
//
// That is the point of the whole component. A grid of colour chips says a
// palette is colourful; a prompt and an error line say whether you can READ it —
// whether the red survives its own background, whether the comment grey is still
// there. You choose by looking at the thing you are choosing.
//
// Radix Select rather than a hand-rolled popover: it brings the listbox
// semantics (`role="option"`, `aria-selected`, type-ahead, arrow keys, Escape,
// focus restoration) that the native element gave away for free, and grouping
// with a visible label.

import * as Select from '@radix-ui/react-select';
import { hex, isLightBg, type ColorProfile } from './themes';
import { groupByBrightness, PREVIEW_LINES, type PreviewToken } from './theme-preview';
import './theme-picker.css';

export interface ThemePickerProps {
  profiles: ColorProfile[];
  value: string;
  onChange: (id: string) => void;
  id?: string | undefined;
}

/** The colour a token paints in, resolved against one profile. */
const colorOf = (p: ColorProfile, token: PreviewToken): string =>
  token.slot === 'fg' ? hex(p.fg) : hex(p.ansi16[token.slot] ?? p.fg);

/** One theme rendered in its own palette — the swatch, and the option's body. */
function Swatch({ profile }: { profile: ColorProfile }) {
  return (
    <div
      className="tp-swatch"
      style={{ background: hex(profile.bg), color: hex(profile.fg) }}
      data-testid={`theme-swatch-${profile.id}`}
    >
      <div className="tp-swatch-title">
        <span className="tp-swatch-name">{profile.name}</span>
        {/* A block cursor where a terminal would leave one. It uses the theme's
            explicit cursor colour when it has one, because that is a colour a
            palette can get wrong on its own and nothing else here shows it. */}
        <span
          className="tp-swatch-cursor"
          style={{ background: hex(profile.cursor ?? profile.fg) }}
          aria-hidden="true"
        />
      </div>
      {PREVIEW_LINES.map((line, i) => (
        <div className="tp-swatch-line" key={i} aria-hidden="true">
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
}

function Group({ label, profiles }: { label: string; profiles: ColorProfile[] }) {
  if (profiles.length === 0) return null;
  return (
    <Select.Group>
      <Select.Label className="tp-group">{label}</Select.Label>
      {profiles.map((p) => (
        <Select.Item className="tp-item" key={p.id} value={p.id} data-testid={`theme-opt-${p.id}`}>
          {/* ItemText is what Radix clones into the closed trigger, so it holds
              the NAME alone — cloning a full swatch in there would put a second
              terminal inside a 28px row. */}
          <Select.ItemText>{p.name}</Select.ItemText>
          <Swatch profile={p} />
          <Select.ItemIndicator className="tp-check">✓</Select.ItemIndicator>
        </Select.Item>
      ))}
    </Select.Group>
  );
}

export function ThemePicker({ profiles, value, onChange, id }: ThemePickerProps) {
  const { dark, light } = groupByBrightness(profiles, isLightBg);
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger className="tp-trigger" id={id} data-testid="set-theme" aria-label="Theme">
        <Select.Value />
        <Select.Icon className="tp-trigger-icon">▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        {/* `position="popper"` and a max height: a swatch is three lines tall, so
            twenty of them do not fit anywhere and the list HAS to scroll. */}
        <Select.Content className="tp-content" position="popper" sideOffset={4} collisionPadding={8}>
          <Select.ScrollUpButton className="tp-scroll">▴</Select.ScrollUpButton>
          <Select.Viewport className="tp-viewport">
            <Group label="Dark" profiles={dark} />
            <Group label="Light" profiles={light} />
          </Select.Viewport>
          <Select.ScrollDownButton className="tp-scroll">▾</Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
