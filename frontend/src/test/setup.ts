// Registers a DOM on the global scope for `bun test`.
//
// This module has an import side effect and must be imported *first* by every
// test file that touches the DOM: `@testing-library/react` and React itself
// capture `document`/`window` at import time, so the registrator has to win
// that race.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof globalThis.document === "undefined") {
  GlobalRegistrator.register();
}

const { expect, afterEach, mock } = await import("bun:test");
const { cleanup } = await import("@testing-library/react");
const matchers = await import("@testing-library/jest-dom/matchers");

// Extend Bun's expect with jest-dom matchers (toBeInTheDocument, etc.)
expect.extend(matchers.default ?? matchers);

// Cleanup after each test
afterEach(() => {
  cleanup();
});

// Mock window.matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: mock((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: mock(),
    removeListener: mock(),
    addEventListener: mock(),
    removeEventListener: mock(),
    dispatchEvent: mock(),
  })),
});

// Mock IntersectionObserver
globalThis.IntersectionObserver = class IntersectionObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  takeRecords() {
    return [];
  }
  unobserve() {}
} as unknown as typeof IntersectionObserver;
