// The web-pane URL policy lives in @palmux/shared so the client (before send)
// and the server (before store/rebroadcast) enforce exactly the same rules.
// Re-exported here for the pane components' existing imports.
export { normalizeTabUrl as normalizeUrl, isEmbeddableUrl, isSameOriginUrl } from '@palmux/shared';
