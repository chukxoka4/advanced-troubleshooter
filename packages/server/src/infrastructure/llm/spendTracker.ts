import { SpendCapExceededError } from "./types.js";

/**
 * Per-provider daily spend tracker. Window is an UTC calendar day so
 * book-keeping does not rely on a scheduler. Each provider owns one instance.
 */

export interface SpendTrackerOptions {
  provider: string;
  dailyCapUsd: number;
  now?: () => Date;
}

export interface SpendTracker {
  assertWithinCap(): void;
  record(costUsd: number): void;
  getSpendToday(): number;
}

export function createSpendTracker(options: SpendTrackerOptions): SpendTracker {
  const now = options.now ?? (() => new Date());
  let windowKey = utcDayKey(now());
  let spent = 0;

  function roll(): void {
    const current = utcDayKey(now());
    if (current !== windowKey) {
      windowKey = current;
      spent = 0;
    }
  }

  return {
    assertWithinCap() {
      roll();
      if (spent >= options.dailyCapUsd) {
        throw new SpendCapExceededError(options.provider, options.dailyCapUsd);
      }
    },
    record(costUsd: number) {
      roll();
      spent += Math.max(0, costUsd);
    },
    getSpendToday() {
      roll();
      return spent;
    },
  };
}

function utcDayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}
