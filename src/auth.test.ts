import { describe, it, expect, beforeEach, vi } from "vitest";
import { isWriteEnabled, setWriteEnabled } from "./auth";

// vitest runs in Node by default; stub a minimal localStorage so the helpers work.
beforeEach(() => {
  const store = new Map<string, string>();
  const localStorageStub = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: () => null,
    length: 0,
  };
  vi.stubGlobal("localStorage", localStorageStub);
});

describe("write-scope toggle", () => {
  it("defaults to disabled when nothing is stored", () => {
    expect(isWriteEnabled()).toBe(false);
  });

  it("roundtrips through localStorage", () => {
    setWriteEnabled(true);
    expect(isWriteEnabled()).toBe(true);
    setWriteEnabled(false);
    expect(isWriteEnabled()).toBe(false);
  });

  it("treats any non-'true' string as disabled", () => {
    // Simulate a stale or malformed value.
    localStorage.setItem("linear-planner-write-enabled", "yes");
    expect(isWriteEnabled()).toBe(false);
    localStorage.setItem("linear-planner-write-enabled", "1");
    expect(isWriteEnabled()).toBe(false);
  });
});
