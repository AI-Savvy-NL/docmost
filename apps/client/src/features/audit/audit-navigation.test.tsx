import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import SettingsSidebar from "@/components/settings/settings-sidebar.tsx";

const mocks = vi.hoisted(() => ({ role: "owner", prefetch: vi.fn() }));
vi.mock("@/hooks/use-user-role.tsx", () => ({
  default: () => ({
    isOwner: mocks.role === "owner",
    isAdmin: ["owner", "admin"].includes(mocks.role),
  }),
}));
vi.mock("@/components/settings/app-version.tsx", () => ({ default: () => null }));
vi.mock("@/features/integration/queries/integration-query", () => ({
  useInstalledIntegrations: () => ({ data: [] }),
}));
vi.mock("@/components/settings/settings-queries.tsx", () => ({
  prefetchBilling: mocks.prefetch,
  prefetchGroups: mocks.prefetch,
  prefetchScimTokens: mocks.prefetch,
  prefetchShares: mocks.prefetch,
  prefetchSpaces: mocks.prefetch,
  prefetchSsoProviders: mocks.prefetch,
  prefetchWorkspaceMembers: mocks.prefetch,
  prefetchVerifiedPages: mocks.prefetch,
}));
const i18n = createInstance();

describe("Independent audit navigation", () => {
  beforeAll(async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
        addListener: vi.fn(), removeListener: vi.fn(),
      }),
    });
    await i18n.init({ lng: "en", resources: { en: { translation: {} } } });
  });
  afterAll(() => vi.unstubAllGlobals());
  afterEach(() => cleanup());
  it.each(["owner", "admin", "member"])("offers basic audit history only to an owner, role=%s", (role) => {
    mocks.role = role;
    render(
      <MantineProvider>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter><SettingsSidebar /></MemoryRouter>
        </I18nextProvider>
      </MantineProvider>,
    );
    const link = screen.queryByRole("link", { name: "Audit logs", exact: true });
    if (role === "owner") {
      expect(link?.getAttribute("href")).toBe("/settings/audit");
      expect(link?.getAttribute("aria-disabled")).not.toBe("true");
    } else {
      expect(link).toBeNull();
    }
  });
});
