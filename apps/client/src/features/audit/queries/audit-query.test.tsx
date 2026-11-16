import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuditHistory } from "./audit-query.ts";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api-client.ts", () => ({ default: { post: mocks.post } }));
const clients: QueryClient[] = [];
function setup(owner = true, workspaceId = "workspace") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook(() => useAuditHistory(workspaceId, owner, { limit: 50 }), { wrapper }) };
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.clearAllMocks();
});
describe("Independent audit history query", () => {
  it("does not request owner history for other roles", () => {
    setup(false);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("uses its own workspace-scoped cache without a client workspace override", async () => {
    mocks.post.mockResolvedValue({ data: { items: [], meta: {}, captureStatus: {} } });
    const { result, client } = setup();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.post).toHaveBeenCalledWith("/wikisavvy/audit/history", { limit: 50 });
    expect(client.getQueriesData({ queryKey: ["wikisavvy-audit", "workspace"] })).toHaveLength(1);
    expect(client.getQueriesData({ queryKey: ["wikisavvy-audit", "other"] })).toHaveLength(0);
  });
  it("does not retain raw transport diagnostics", async () => {
    mocks.post.mockRejectedValue({ config: { headers: { authorization: "synthetic-sensitive-details" } } });
    const { result } = setup();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(String(result.current.error)).toBe("Error: Audit history could not be loaded");
    expect(Object.keys(result.current.error as object)).not.toContain("config");
  });
});
