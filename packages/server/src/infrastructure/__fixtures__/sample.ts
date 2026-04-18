export type Point = { x: number; y: number };

export const ORIGIN: Point = { x: 0, y: 0 };

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export class Vec {
  constructor(public x: number, public y: number) {}
  length(): number {
    return Math.hypot(this.x, this.y);
  }
}
