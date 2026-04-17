/**
 * APP_MODE is the single switch between prototype and production behaviour.
 * Every middleware reads from here rather than process.env directly so that
 * the mode is parsed once at boot, validated once, and cannot drift between
 * layers.
 */

export const APP_MODES = ["prototype", "production"] as const;
export type AppMode = (typeof APP_MODES)[number];

export class InvalidAppModeError extends Error {
  constructor(received: string | undefined) {
    super(
      `APP_MODE must be one of ${APP_MODES.join(" | ")}; received ${
        received === undefined ? "undefined" : `"${received}"`
      }`,
    );
    this.name = "InvalidAppModeError";
  }
}

/**
 * Pure parser. Exported so tests can exercise every input path without
 * mutating process.env.
 */
export function parseAppMode(raw: string | undefined): AppMode {
  if (raw === undefined || raw.length === 0) throw new InvalidAppModeError(raw);
  const normalised = raw.toLowerCase() as AppMode;
  if (!(APP_MODES as readonly string[]).includes(normalised)) {
    throw new InvalidAppModeError(raw);
  }
  return normalised;
}

/**
 * Boot-time resolved APP_MODE. Throws at module load if the env var is
 * missing or invalid, so a misconfigured deployment fails immediately
 * rather than silently degrading to the wrong behaviour.
 */
export const appMode: AppMode = parseAppMode(process.env.APP_MODE);

export function isProduction(): boolean {
  return appMode === "production";
}

export function isPrototype(): boolean {
  return appMode === "prototype";
}
