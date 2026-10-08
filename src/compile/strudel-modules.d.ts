// The @strudel/* packages ship no type declarations. The compiler worker
// (./worker.ts) only imports them to read their export names.
declare module "@strudel/core";
declare module "@strudel/mini";
declare module "@strudel/tonal";
