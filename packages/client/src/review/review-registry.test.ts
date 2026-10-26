import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerReview,
  resetReviewRegistry,
  reviewApiFor,
  type ReviewApi,
} from './review-registry';

const api = (): ReviewApi => ({
  nextChange: vi.fn(),
  prevChange: vi.fn(),
  nextFile: vi.fn(),
  prevFile: vi.fn(),
  reviewCurrent: vi.fn(),
});

beforeEach(() => resetReviewRegistry());

describe('review registry', () => {
  it('finds a pane by its tab id, and nothing for a tab that is not a review', () => {
    const a = api();
    registerReview('7', a);
    expect(reviewApiFor('7')).toBe(a);
    expect(reviewApiFor('8')).toBeUndefined();
  });

  it('keeps one pane per tab and drops it on unregister', () => {
    const a = api();
    const off = registerReview('7', a);
    off();
    expect(reviewApiFor('7')).toBeUndefined();
  });

  // A pane keyed by its address remounts when the address changes; its replacement
  // registers before the old one's cleanup runs, and must not be unregistered by it.
  it('does not let a replaced pane unregister the one that took its place', () => {
    const first = api();
    const second = api();
    const offFirst = registerReview('7', first);
    registerReview('7', second);
    offFirst();
    expect(reviewApiFor('7')).toBe(second);
  });
});
