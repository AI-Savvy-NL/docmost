import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteLocalPageData } from "./local-page-data";

function stubIndexedDB(names: string[]) {
  const deleteDatabase = vi.fn(() => {
    const request: Record<string, () => void> = {};
    setTimeout(() => request.onsuccess?.());
    return request;
  });
  vi.stubGlobal("indexedDB", {
    databases: async () => names.map((name) => ({ name, version: 1 })),
    deleteDatabase,
  });
  return deleteDatabase;
}

describe("deleteLocalPageData", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deletes only the page databases", async () => {
    const deleteDatabase = stubIndexedDB(["page.a", "page.b", "other-db"]);

    await deleteLocalPageData();

    expect(deleteDatabase.mock.calls).toEqual([["page.a"], ["page.b"]]);
  });

  it("gives up after a bounded wait when IndexedDB never responds", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("indexedDB", {
        databases: () => new Promise(() => {}),
        deleteDatabase: vi.fn(),
      });
      const pending = deleteLocalPageData();
      await vi.advanceTimersByTimeAsync(5000);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing when the browser cannot list databases", async () => {
    vi.stubGlobal("indexedDB", { deleteDatabase: vi.fn() });

    await expect(deleteLocalPageData()).resolves.toBeUndefined();
  });
});
