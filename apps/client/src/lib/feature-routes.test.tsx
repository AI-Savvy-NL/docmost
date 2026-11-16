import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { HelmetProvider } from "react-helmet-async";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Outlet } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import App from "../App.tsx";

vi.mock("@/components/layouts/global/layout.tsx", () => ({
  default: () => <Outlet />,
}));
vi.mock("@/features/workspace/components/workspace-locale-layout.tsx", () => ({
  default: () => <Outlet />,
}));
vi.mock("@/ee/hooks/use-redirect-to-cloud-select.tsx", () => ({
  useRedirectToCloudSelect: () => {},
}));
vi.mock("@/hooks/use-track-origin", () => ({ useTrackOrigin: () => {} }));
vi.mock("@/ee/announcement/components/announcement-banners.tsx", () => ({
  default: () => null,
}));
vi.mock("@/ee/ai/pages/ai-settings.tsx", () => ({
  default: () => <div>Legacy sales screen</div>,
}));
vi.mock("@/ee/ai-chat/pages/ai-chat.tsx", () => ({
  default: () => <div>Legacy sales screen</div>,
}));
vi.mock("@/ee/announcement/pages/announcements", () => ({
  default: () => <div>Legacy sales screen</div>,
}));
vi.mock("@/ee/api-key/pages/user-api-keys", () => ({
  default: () => <div>Legacy sales screen</div>,
}));
vi.mock("@/ee/api-key/pages/workspace-api-keys", () => ({
  default: () => <div>Legacy sales screen</div>,
}));
vi.mock("@/features/audit/pages/audit-log.tsx", () => ({
  default: () => <div>Independent owner audit history</div>,
}));
vi.mock("@/ee/audit/pages/audit-logs.tsx", () => ({
  default: () => <div>Legacy sales screen</div>,
}));
vi.mock("@/ee/security/pages/security.tsx", () => ({
  default: () => <div>Existing security controls</div>,
}));
vi.mock("@/ee/mfa/pages/mfa-challenge-page", () => ({
  MfaChallengePage: () => <div>Existing MFA challenge</div>,
}));
const i18n = createInstance();
function show(path: string) {
  return render(
    <HelmetProvider>
      <MantineProvider>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter initialEntries={[path]}>
            <App />
          </MemoryRouter>
        </I18nextProvider>
      </MantineProvider>
    </HelmetProvider>,
  );
}
describe("Independent unavailable feature routes", () => {
  beforeAll(async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      }),
    });
    await i18n.init({ lng: "en", resources: { en: { translation: {} } } });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  it.each([
    "/ai",
    "/ai/chat/existing-chat",
    "/settings/ai",
    "/settings/ai/mcp",
    "/settings/announcements",
    "/settings/account/api-keys",
    "/settings/account/api-keys/authorized-apps",
    "/settings/api-keys",
    "/settings/audit/siem",
    "/settings/siem",
  ])(
    "shows honest availability without upstream sales UI at %s",
    async (path) => {
      const fetch = vi.spyOn(globalThis, "fetch");
      show(path);
      expect(await screen.findByText("Not implemented yet")).toBeTruthy();
      expect(document.body.textContent).toContain("WikiSavvy");
      expect(document.body.textContent).not.toMatch(
        /Docmost|Legacy sales screen|contact sales/i,
      );
      expect(screen.queryByRole("link")).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
      fetch.mockRestore();
    },
  );
  it("routes audit history to the independently owned viewer", async () => {
    show("/settings/audit");
    expect(await screen.findByText("Independent owner audit history")).toBeTruthy();
    expect(screen.queryByText("Legacy sales screen")).toBeNull();
  });
  it("keeps existing security controls reachable", async () => {
    show("/settings/security");
    expect(await screen.findByText("Existing security controls")).toBeTruthy();
    expect(screen.queryByText("Not implemented yet")).toBeNull();
  });
  it("keeps existing MFA challenge routing", async () => {
    show("/login/mfa");
    expect(await screen.findByText("Existing MFA challenge")).toBeTruthy();
    expect(screen.queryByText("Not implemented yet")).toBeNull();
  });
});
