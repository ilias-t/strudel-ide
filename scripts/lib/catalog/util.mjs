// Shared helpers for the catalog generator: locale-independent ordering and stable JSON.

/** Code-point order (never localeCompare: its order depends on the machine's locale) */
export const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const sortedUnique = (xs) => [...new Set(xs)].sort(byCodePoint);

/** Object with its keys in code-point order (values untouched) */
export const sortKeys = (obj) => Object.fromEntries(Object.keys(obj).sort(byCodePoint).map((k) => [k, obj[k]]));

/** The one JSON format every catalog file uses: 2-space indent, trailing newline */
export const toJson = (value) => JSON.stringify(value, null, 2) + "\n";
