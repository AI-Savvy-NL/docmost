import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWikisavvyLicense } from "./license-query.ts";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api-client.ts", () => ({ default: { post: mocks.post } }));
const clients: QueryClient[] = [];
function setup(owner = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    client,
    ...renderHook(() => useWikisavvyLicense("workspace", owner), { wrapper }),
  };
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.clearAllMocks();
});
describe("WikiSavvy licensing queries", () => {
  it("does not request owner-only status for other users", () => {
    setup(false);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("uses a separate workspace-scoped cache and the authenticated status endpoint", async () => {
    mocks.post.mockResolvedValue({
      data: { workspaceId: "workspace", status: "community" },
    });
    const { result, client } = setup();
    await waitFor(() => expect(result.current.data?.status).toBe("community"));
    expect(mocks.post).toHaveBeenCalledWith("/wikisavvy/licensing/status", {});
    expect(
      client.getQueryData(["wikisavvy-license", "workspace"]),
    ).toBeTruthy();
    expect(client.getQueryData(["license"])).toBeUndefined();
  });
  it("does not retain credential-bearing transport errors", async () => {
    mocks.post.mockResolvedValueOnce({ data: { status: "community" } });
    const { result } = setup();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    mocks.post.mockRejectedValue({
      config: { data: "synthetic-license-material" },
    });
    let error: unknown;
    await act(async () => {
      try {
        await result.current.activate.mutateAsync("synthetic-license-material");
      } catch (value) {
        error = value;
      }
    });
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe(
      "Error: WikiSavvy licensing request could not be completed",
    );
    expect(Object.keys(error as object)).not.toContain("config");
  });
});
