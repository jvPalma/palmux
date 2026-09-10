import { beforeEach, describe, expect, it } from 'vitest';
import { buildDiagnosticsReport } from './diagnostics-report';
import { clearCapturedLogs, installConsoleCapture } from './console-capture';

describe('buildDiagnosticsReport', () => {
  beforeEach(() => {
    installConsoleCapture();
    clearCapturedLogs();
  });

  it('includes version, env, tabs, and captured logs', () => {
    console.warn('boom');
    const report = buildDiagnosticsReport({
      version: '2.0.0+abc1234',
      userAgent: 'test-agent',
      url: 'http://localhost/0',
      tabs: [
        { id: '0', kind: 'terminal' },
        { id: '1', kind: 'editor' },
      ],
      swControlled: false,
      theme: {
        id: 'catppuccin-mocha',
        resolvedId: 'catppuccin-mocha',
        resolvedName: 'Catppuccin Mocha',
        registered: [],
        canvasBg: '#1e1e2e',
        uiBase: '#1e1e2e',
      },
    });
    expect(report).toContain('server version: 2.0.0+abc1234');
    expect(report).toContain('user agent:     test-agent');
    expect(report).toContain('service worker: none');
    expect(report).toContain('- 0 [terminal]');
    expect(report).toContain('- 1 [editor]');
    expect(report).toContain('[warn]');
    expect(report).toContain('boom');
  });

  it('flags a theme id that fell back instead of resolving', () => {
    const report = buildDiagnosticsReport({
      version: '', userAgent: '', url: '', tabs: [], swControlled: false,
      theme: {
        id: 'user:everforest-light-hard',
        resolvedId: 'catppuccin-mocha',
        resolvedName: 'Catppuccin Mocha',
        registered: ['kitty'],
        canvasBg: '#1e1e2e',
        uiBase: '#fffbef',
      },
    });
    expect(report).toContain('<< FELL BACK');
    // canvas dark, UI light — the exact shape of "terminal ignored my theme".
    expect(report).toContain('<< MISMATCH');
  });

  it('is quiet when the canvas and the UI agree', () => {
    const report = buildDiagnosticsReport({
      version: '', userAgent: '', url: '', tabs: [], swControlled: false,
      theme: {
        id: 'user:everforest-light-hard',
        resolvedId: 'user:everforest-light-hard',
        resolvedName: 'Everforest Light Hard',
        registered: ['user:everforest-light-hard'],
        canvasBg: '#FFFBEF',
        uiBase: '#fffbef',
      },
    });
    expect(report).not.toContain('FELL BACK');
    expect(report).not.toContain('MISMATCH'); // case-insensitive compare
  });
});
