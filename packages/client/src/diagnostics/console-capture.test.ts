import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capturedLogs, clearCapturedLogs, installConsoleCapture } from './console-capture';

describe('console-capture', () => {
  beforeEach(() => {
    installConsoleCapture();
    clearCapturedLogs();
  });
  afterEach(() => vi.restoreAllMocks());

  it('captures warn + error and still calls through', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    console.warn('a warning', 42);
    console.error('an error');
    spy.mockRestore();
    const logs = capturedLogs();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ level: 'warn', message: 'a warning 42' });
    expect(logs[1]).toMatchObject({ level: 'error', message: 'an error' });
  });

  it('is bounded to the ring size', () => {
    for (let i = 0; i < 80; i++) console.warn(`w${i}`);
    const logs = capturedLogs();
    expect(logs.length).toBeLessThanOrEqual(50);
    expect(logs[logs.length - 1]!.message).toBe('w79');
  });

  it('installs idempotently (double install does not double-capture)', () => {
    installConsoleCapture();
    installConsoleCapture();
    clearCapturedLogs();
    console.warn('once');
    expect(capturedLogs()).toHaveLength(1);
  });
});
