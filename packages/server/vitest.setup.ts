/**
 * Default environment for vitest. The server's config modules are designed
 * to throw at import time when required env vars are missing, so tests need
 * harmless defaults before anything under src/ loads. Individual tests may
 * override these via process.env + re-import where needed.
 */

process.env.APP_MODE ??= "prototype";
