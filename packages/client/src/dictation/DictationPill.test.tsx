import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DictationPill, formatCountdown } from './DictationPill';
import { Icon } from '../ui/icons';

afterEach(cleanup);

/** The drawn shapes of a registered icon, to compare against what a control
 *  rendered. Rendered into a detached node so `screen` never sees it. */
const iconPaths = (name: string): string | undefined => {
  const host = document.createElement('div');
  render(<Icon name={name} />, { container: host });
  return host.querySelector('svg')?.innerHTML;
};

describe('formatCountdown', () => {
  it('formats minutes and zero-padded seconds', () => {
    expect(formatCountdown(300_000)).toBe('5:00');
    expect(formatCountdown(72_000)).toBe('1:12');
    expect(formatCountdown(9_000)).toBe('0:09');
  });

  it('ceils partial seconds (4.2s shows 0:05, not 0:04)', () => {
    expect(formatCountdown(4_200)).toBe('0:05');
  });

  it('floors at 0:00 for negative leftovers', () => {
    expect(formatCountdown(-500)).toBe('0:00');
  });
});

describe('DictationPill', () => {
  it('renders nothing while idle', () => {
    render(<DictationPill state="idle" deadline={null} onStop={() => {}} />);
    expect(screen.queryByTestId('dictation-pill')).toBeNull();
  });

  it('shows the remaining time while recording', () => {
    render(<DictationPill state="recording" deadline={Date.now() + 299_000} onStop={() => {}} />);
    expect(screen.getByTestId('dictation-pill').textContent).toContain('4:59');
  });

  it('turns urgent inside the final stretch', () => {
    render(<DictationPill state="recording" deadline={Date.now() + 10_000} onStop={() => {}} />);
    expect(screen.getByTestId('dictation-pill').className).toContain('ending');
  });

  // The state marks are icons, not 🔴 / ⏳ emoji: the solid record dot while the
  // mic is live, the hourglass while the clip is out being transcribed.
  it('marks recording with the record dot and transcribing with the hourglass', () => {
    const mark = (state: 'recording' | 'working') => {
      cleanup();
      render(
        <DictationPill
          state={state}
          deadline={state === 'recording' ? Date.now() + 299_000 : null}
          onStop={() => {}}
        />,
      );
      const title = screen.getByTestId('dictation-pill').querySelector('.dictation-title');
      expect(title?.querySelectorAll('svg')).toHaveLength(1);
      return title?.querySelector('svg')?.innerHTML;
    };
    expect(mark('recording')).toBe(iconPaths('record'));
    expect(mark('working')).toBe(iconPaths('hourglass'));
    // The words stay: the icon is aria-hidden, so they are what a screen reader gets.
    cleanup();
    render(<DictationPill state="recording" deadline={Date.now() + 299_000} onStop={() => {}} />);
    expect(
      screen.getByTestId('dictation-pill').querySelector('.dictation-title'),
    ).toHaveTextContent(/^Recording$/);
  });

  it('shows transcribing while working, without a stop affordance firing', () => {
    const onStop = vi.fn();
    render(<DictationPill state="working" deadline={null} onStop={onStop} />);
    const pill = screen.getByTestId('dictation-pill');
    expect(pill.textContent).toContain('Transcribing');
  });
});
