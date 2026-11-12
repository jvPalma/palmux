// ── Adding a project ──────────────────────────────────────────────────────────
//
// One rule for every way a project arrives: the Add project form, and `palmux git`
// naming its shell's work tree (the one exception to "the view starts with no
// project", because the user asked for it by name). The top is canonicalised the way
// the synced list is (`normalizePin`), so the same project in another spelling is
// not a second entry: it only becomes the active one.

import { normalizePin } from '../panes/explorer-pins';
import type { ClientSettings } from '../settings/settings';

/** The settings change that adds `top` (when missing) and makes it this device's active project. */
export function addScmProject(
  settings: Pick<ClientSettings, 'scmRepos'>,
  top: string,
): Partial<Pick<ClientSettings, 'scmRepos' | 'scmActiveRepo'>> {
  const canonical = normalizePin(top);
  if (canonical === '') return {};
  if (settings.scmRepos.some((repo) => normalizePin(repo) === canonical)) {
    return { scmActiveRepo: canonical };
  }
  return { scmRepos: [...settings.scmRepos, canonical], scmActiveRepo: canonical };
}
