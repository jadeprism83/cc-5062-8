export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function distance(x0, y0, x1, y1) {
  return Math.hypot(x1 - x0, y1 - y0);
}

export function pointDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
