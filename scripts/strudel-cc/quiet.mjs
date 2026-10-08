// Import first: @strudel/core prints a banner and a "not in browser" warning
// when it loads, and its repl logs every evaluation. Keep those off stdout,
// where `npm run export` writes the code.
const NOISE = [/@strudel\/core loaded/, /cannot use window/, /^\[eval\]/, /^%c\[eval\]/];
for (const level of ["log", "warn", "info"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    if (typeof args[0] === "string" && NOISE.some((re) => re.test(args[0]))) return;
    original(...args);
  };
}
