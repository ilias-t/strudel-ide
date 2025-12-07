/// <reference types="vite/client" />

interface ImportMeta {
  readonly hot?: {
    accept(deps: string | string[], callback: (modules: any) => void): void;
  };
}
