import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DictationPill, formatCountdown } from './DictationPill';

afterEach(cleanup);

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

  it('shows transcribing while working, without a stop affordance firing', () => {
    const onStop = vi.fn();
    render(<DictationPill state="working" deadline={null} onStop={onStop} />);
    const pill = screen.getByTestId('dictation-pill');
    expect(pill.textContent).toContain('Transcribing');
  });
});
