import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { MemoryRouter } from "react-router-dom";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { entitlementAtom } from "@/ee/entitlement/entitlement-atom";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import SettingsSidebar from "./settings-sidebar";

const state = vi.hoisted(() => ({
  owner: true,
  admin: true,
  sso: vi.fn(),
  scim: vi.fn(),
}));
vi.mock("@/hooks/use-user-role.tsx", () => ({
  default: () => ({ isOwner: state.owner, isAdmin: state.admin }),
}));
vi.mock("@/lib/config.ts", () => ({ isCloud: () => false }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (value: string) => value }),
}));
vi.mock("@/ee/hooks/use-upgrade-label", () => ({
  useUpgradeLabel: () => "Unavailable",
}));
vi.mock("@/hooks/use-settings-navigation", () => ({
  useSettingsNavigation: () => ({ goBack: vi.fn() }),
}));
vi.mock(
  "@/components/layouts/global/hooks/hooks/use-toggle-sidebar.ts",
  () => ({ useToggleSidebar: () => vi.fn() }),
);
vi.mock("@/features/integration/queries/integration-query", () => ({
  useInstalledIntegrations: () => ({ data: [] }),
}));
vi.mock("@/components/settings/app-version.tsx", () => ({
  default: () => null,
}));
vi.mock("@/components/settings/settings-queries.tsx", () => ({
  prefetchBilling: vi.fn(),
  prefetchGroups: vi.fn(),
  prefetchShares: vi.fn(),
  prefetchSpaces: vi.fn(),
  prefetchWorkspaceMembers: vi.fn(),
  prefetchVerifiedPages: vi.fn(),
  prefetchSsoProviders: state.sso,
  prefetchScimTokens: state.scim,
}));
function show(exportDisabled = false, features: string[] = []) {
  const store = createStore();
  store.set(entitlementAtom, { features } as never);
  store.set(currentUserAtom, {
    user: {},
    workspace: { settings: { export: { disabled: exportDisabled } } },
  } as never);
  return render(
    <MantineProvider>
      <Provider store={store}>
        <MemoryRouter>
          <SettingsSidebar />
        </MemoryRouter>
      </Provider>
    </MantineProvider>,
  );
}
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
});
beforeEach(() => {
  state.owner = true;
  state.admin = true;
  vi.clearAllMocks();
  localStorage.clear();
});
afterEach(cleanup);
describe("Original Security & SSO navigation", () => {
  it("preserves existing entitled security navigation and prefetch", () => {
    state.owner = false;
    show(false, ["security:settings"]);
    const link = screen.getByRole("link", { name: "Security & SSO" });
    expect(link.getAttribute("href")).toBe("/settings/security");
    fireEvent.mouseEnter(link);
    expect(state.sso).toHaveBeenCalledTimes(1);
    expect(state.scim).toHaveBeenCalledTimes(1);
  });
  it("opens the original security location for an owner without granting other features", () => {
    show();
    const link = screen.getByRole("link", { name: "Security & SSO" });
    expect(link.getAttribute("href")).toBe("/settings/security");
    expect(link.getAttribute("aria-disabled")).not.toBe("true");
    expect(
      screen
        .getByRole("link", { name: "Verified pages" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.mouseEnter(link);
    expect(state.sso).not.toHaveBeenCalled();
    expect(state.scim).not.toHaveBeenCalled();
  });
  it("does not grant a non-owner administrator independent provider management", () => {
    state.owner = false;
    show();
    expect(
      screen
        .getByRole("link", { name: "Security & SSO" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });
  it("keeps the existing export-disable recovery entry reachable", () => {
    state.owner = false;
    show(true);
    expect(
      screen.getByRole("link", { name: "Security & SSO" }).getAttribute("href"),
    ).toBe("/settings/security");
  });
  it("does not show workspace security administration to members", () => {
    state.owner = false;
    state.admin = false;
    show();
    expect(screen.queryByRole("link", { name: "Security & SSO" })).toBeNull();
  });
});
