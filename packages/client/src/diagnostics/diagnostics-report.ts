import { capturedLogs } from './console-capture';

export interface DiagnosticsInput {
  /** Server build version last seen on `ready`. */
  version: string;
  userAgent: string;
  url: string;
  tabs: { id: string; kind: string }[];
  /** Whether a service worker currently controls the page. */
  swControlled: boolean;
  /** Theme resolution, end to end. The interesting case is a MISMATCH: a
   *  `user:`/emulator theme resolves to the default until the server's `themes`
   *  broadcast registers it, so the UI tokens and the xterm canvas can disagree
   *  about which theme is active — invisible in a screenshot, obvious here. */
  theme: {
    /** The id in settings (what the user picked). */
    id: string;
    /** What that id actually resolves to right now — `id` again unless it fell back. */
    resolvedId: string;
    resolvedName: string;
    /** Ids currently in the dynamic registry (from the `themes` broadcast). */
    registered: string[];
    /** Background the xterm canvas is actually painting, or null with no terminal. */
    canvasBg: string | null;
    /** The app's own `--t-base` token; should equal canvasBg. */
    uiBase: string;
  };
}

/** Assemble a plain-text diagnostics bundle (version, env, tabs, captured logs). */
export function buildDiagnosticsReport(input: DiagnosticsInput): string {
  const lines: string[] = [
    'palmux diagnostics report',
    `generated:      ${new Date().toISOString()}`,
    '',
    `server version: ${input.version || '(unknown)'}`,
    `url:            ${input.url}`,
    `user agent:     ${input.userAgent}`,
    `service worker: ${input.swControlled ? 'controlling' : 'none'}`,
    '',
    'theme:',
    `  settings id:    ${input.theme.id}`,
    `  resolves to:    ${input.theme.resolvedId} "${input.theme.resolvedName}"` +
      (input.theme.resolvedId === input.theme.id ? '' : '   << FELL BACK'),
    `  registered:     ${input.theme.registered.join(', ') || '(none)'}`,
    `  xterm canvas:   ${input.theme.canvasBg ?? '(no terminal)'}`,
    `  ui --t-base:    ${input.theme.uiBase}` +
      (input.theme.canvasBg && input.theme.canvasBg.toLowerCase() !== input.theme.uiBase.toLowerCase()
        ? '   << MISMATCH: canvas and UI disagree'
        : ''),
    '',
    `tabs (${input.tabs.length}):`,
    ...input.tabs.map((t) => `  - ${t.id} [${t.kind}]`),
    '',
  ];
  const logs = capturedLogs();
  lines.push(`captured console (${logs.length}):`);
  for (const l of logs) {
    lines.push(`  [${l.level}] ${new Date(l.at).toISOString()} ${l.message}`);
  }
  return lines.join('\n');
}
