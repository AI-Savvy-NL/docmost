import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { HelmetProvider } from "react-helmet-async";
import { I18nextProvider } from "react-i18next";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AuditLog from "./audit-log.tsx";

const mocks = vi.hoisted(() => ({ user: vi.fn(), query: vi.fn() }));
vi.mock("@/features/user/hooks/use-current-user.ts", () => ({ default: mocks.user }));
vi.mock("../queries/audit-query.ts", () => ({ useAuditHistory: mocks.query }));
const i18n = createInstance();
const workspaceId = "11111111-1111-4111-8111-111111111111";
let query: any;
function show() {
  return render(<HelmetProvider><MantineProvider><I18nextProvider i18n={i18n}><AuditLog /></I18nextProvider></MantineProvider></HelmetProvider>);
}
describe("Independent owner audit history", () => {
  beforeAll(async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn().mockReturnValue({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
    }) });
    await i18n.init({ lng: "en", resources: { en: { translation: {} } } });
  });
  afterAll(() => vi.unstubAllGlobals());
  beforeEach(() => {
    query = {
      data: { items: [], meta: { hasNextPage: false, nextCursor: null },
        captureStatus: { recorded: 0, rejected: 0, failed: 0, scope: "server-process" } },
      isPending: false, isError: false, isFetching: false, refetch: vi.fn(),
    };
    mocks.query.mockImplementation(() => query);
    mocks.user.mockReturnValue({ data: { user: { role: "owner", workspaceId } }, isPending: false });
  });
  afterEach(() => cleanup());
  it("shows an honest empty state without license or upstream sales claims", () => {
    show();
    expect(screen.getByText("No audit events have been recorded yet.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Docmost|upgrade|contact sales/i);
    expect(screen.queryByRole("link")).toBeNull();
  });
  it.each(["member", "admin"])("does not fetch or expose cached owner history to %s", (role) => {
    mocks.user.mockReturnValue({ data: { user: { role, workspaceId } } });
    query.data.items = [{ id: "id", event: "private-event" }];
    show();
    expect(mocks.query).toHaveBeenCalledWith(workspaceId, false, expect.any(Object));
    expect(screen.getByText("Only workspace owners can view audit history.")).toBeTruthy();
    expect(screen.queryByText("private-event")).toBeNull();
  });
  it("shows loading without a false empty history", () => {
    query.isPending = true;
    query.data = undefined;
    show();
    expect(screen.getByText("Loading audit history…")).toBeTruthy();
    expect(screen.queryByText("No audit events have been recorded yet.")).toBeNull();
  });
  it("shows safe errors and supports retry", () => {
    query.isError = true;
    query.data = undefined;
    show();
    expect(screen.getByText("Audit history is unavailable.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(query.refetch).toHaveBeenCalled();
  });
  it("renders identifiers and a process-local failure warning", () => {
    query.data.items = [{
      id: "event-id", createdAt: "2026-11-16T00:00:00Z", event: "user.login",
      actorId: "actor-id", actorType: "user", resourceType: "user", resourceId: "resource-id",
    }];
    query.data.captureStatus.failed = 1;
    show();
    expect(screen.getByText("user.login")).toBeTruthy();
    expect(screen.getByText("actor-id")).toBeTruthy();
    expect(screen.getByText("resource-id")).toBeTruthy();
    expect(screen.getByText("Some audit events could not be recorded. Counters cover this server process only.")).toBeTruthy();
  });
  it("uses bounded forward pagination and a local back stack", () => {
    query.data.meta = { hasNextPage: true, nextCursor: "encoded-next" };
    show();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(mocks.query).toHaveBeenLastCalledWith(workspaceId, true, { limit: 50, cursor: "encoded-next" });
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(mocks.query).toHaveBeenLastCalledWith(workspaceId, true, { limit: 50, cursor: undefined });
  });
});
