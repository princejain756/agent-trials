export function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), lo);
}

export function divide(a, b) {
  return a / b;
}

export function slugify(s) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
