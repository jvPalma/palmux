import { useCallback, useState } from 'react';
import type { JsonObject } from '@palmux/shared';
import {
  type ClientSettings,
  loadSettings,
  mergeServerSettings,
  notifySettingsChange,
  sanitize,
  saveSettings,
  toServerSettings,
} from './settings';

export interface UseSettingsResult {
  settings: ClientSettings;
  /** Apply a local change: persist, and mirror the synced subset to the server. */
  update: (partial: Partial<ClientSettings>) => void;
  /** Apply an incoming server settings blob (no echo back). */
  applyServer: (server: JsonObject) => void;
}

export function useSettings(send: (server: JsonObject) => void): UseSettingsResult {
  const [settings, setSettings] = useState<ClientSettings>(loadSettings);

  const update = useCallback(
    (partial: Partial<ClientSettings>) => {
      setSettings((prev) => {
        const next = sanitize({ ...prev, ...partial });
        saveSettings(next);
        send(toServerSettings(next));
        queueMicrotask(() => notifySettingsChange(next));
        return next;
      });
    },
    [send],
  );

  const applyServer = useCallback((server: JsonObject) => {
    setSettings((prev) => {
      const next = mergeServerSettings(prev, server);
      saveSettings(next);
      queueMicrotask(() => notifySettingsChange(next));
      return next;
    });
  }, []);

  return { settings, update, applyServer };
}
