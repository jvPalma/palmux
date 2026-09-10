import { useCallback, useState } from 'react';
import type { JsonObject } from '@palmux/shared';
import { type ExtraKeysConfig, DEFAULT_EXTRA_KEYS, mergeExtraKeys } from './extra-keys';

export interface UseExtraKeysResult {
  config: ExtraKeysConfig;
  applyServer: (server: JsonObject) => void;
  update: (next: ExtraKeysConfig) => void;
}

function toWire(config: ExtraKeysConfig): JsonObject {
  return {
    enabled: config.enabled,
    layout: config.layout as unknown as JsonObject['layout'],
  } as JsonObject;
}

export function useExtraKeys(send: (server: JsonObject) => void): UseExtraKeysResult {
  const [config, setConfig] = useState<ExtraKeysConfig>(DEFAULT_EXTRA_KEYS);

  const applyServer = useCallback((server: JsonObject) => {
    setConfig(mergeExtraKeys(server));
  }, []);

  const update = useCallback(
    (next: ExtraKeysConfig) => {
      setConfig(next);
      send(toWire(next));
    },
    [send],
  );

  return { config, applyServer, update };
}
