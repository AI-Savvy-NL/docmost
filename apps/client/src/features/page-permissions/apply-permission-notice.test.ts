import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { applyPermissionNotice } from "./apply-permission-notice";

const client = new QueryClient();
const keys = ["page", "slug"];
afterEach(() => client.clear());
function seed() {
  for (const key of keys)
    client.setQueryData(["pages", key], {
      id: "page",
      content: "previously-authorized",
      permissions: { canEdit: true },
    });
}
describe("Live permission notices", () => {
  it("clears both page aliases after access is revoked", () => {
    seed();
    applyPermissionNotice(client, keys, "none");
    for (const key of keys) {
      expect(client.getQueryData(["pages", key])).toBeUndefined();
      expect(client.getQueryState(["pages", key])?.status).toBe("error");
    }
  });
  it("updates both aliases for read-only and restored-write access", () => {
    seed();
    for (const access of ["read", "write"]) {
      applyPermissionNotice(client, keys, access);
      for (const key of keys)
        expect(client.getQueryData(["pages", key])).toMatchObject({
          permissions: { canEdit: access === "write" },
        });
    }
  });
  it("does not create page data for an absent query", () => {
    applyPermissionNotice(client, keys, "write");
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
  it("ignores unknown access values", () => {
    seed();
    applyPermissionNotice(client, keys, "admin");
    expect(client.getQueryData(["pages", "page"])).toMatchObject({
      permissions: { canEdit: true },
    });
  });
});
