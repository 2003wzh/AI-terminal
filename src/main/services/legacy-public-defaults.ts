// electron.vite.config.ts reads this public constant from the legacy CommonJS
// module at build time. The packaged app has no dependency on the source tree,
// and the credential/profile store is never loaded here.
declare const __LEGACY_DEFAULT_CODEX_MODEL__: string

export const LEGACY_DEFAULT_CODEX_MODEL = __LEGACY_DEFAULT_CODEX_MODEL__.trim() || 'gpt-5.5'
