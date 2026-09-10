import { copyText } from './clipboard';

// happy-dom does not implement document.execCommand, so vi.spyOn cannot attach
// to a missing property. Install a mock directly and remove it afterwards.
type ExecCommand = (commandId: string) => boolean;

function setExecCommand(impl: ExecCommand): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl);
  (document as unknown as { execCommand: ExecCommand }).execCommand = fn;
  return fn;
}

describe('copyText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (document as unknown as { execCommand?: ExecCommand }).execCommand;
  });

  it('returns false for empty text without touching the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyText('')).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('uses navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyText('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText }, maxTouchPoints: 0 });
    const exec = setExecCommand(() => true);
    expect(await copyText('hello')).toBe(true);
    expect(writeText).toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('falls back to execCommand when clipboard API is absent', async () => {
    vi.stubGlobal('navigator', {});
    const exec = setExecCommand(() => true);
    expect(await copyText('hello')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('returns the execCommand result on the legacy path', async () => {
    vi.stubGlobal('navigator', {});
    setExecCommand(() => false);
    expect(await copyText('hello')).toBe(false);
  });

  it('returns false when execCommand throws', async () => {
    vi.stubGlobal('navigator', {});
    setExecCommand(() => {
      throw new Error('boom');
    });
    expect(await copyText('hello')).toBe(false);
  });
});
