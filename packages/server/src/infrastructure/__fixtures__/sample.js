const ORIGIN = { x: 0, y: 0 };

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

class Vec {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  length() {
    return Math.hypot(this.x, this.y);
  }
}

module.exports = { ORIGIN, distance, Vec };
