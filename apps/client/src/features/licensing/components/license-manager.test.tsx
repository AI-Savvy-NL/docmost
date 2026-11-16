import { MantineProvider } from "@mantine/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { LicenseStatus } from "@wikisavvy/license";
import LicenseManager from "./license-manager.tsx";

const mocks = vi.hoisted(() => ({ query: vi.fn(), user: vi.fn() }));
vi.mock("@/features/licensing/queries/license-query.ts", () => ({
  useWikisavvyLicense: mocks.query,
}));
vi.mock("@/features/user/hooks/use-current-user.ts", () => ({
  default: mocks.user,
}));
const i18n = createInstance();
const community: LicenseStatus = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  edition: "community",
  status: "community",
  trustConfigured: true,
  features: [],
  implementedCapabilities: [],
  seats: { active: 1, limit: null, overLimit: false },
  license: null,
};
let query: any;
function show() {
  return render(
    <MantineProvider>
      <I18nextProvider i18n={i18n}>
        <LicenseManager />
      </I18nextProvider>
    </MantineProvider>,
  );
}
describe("WikiSavvy license manager", () => {
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
  beforeEach(() => {
    query = {
      data: community,
      isPending: false,
      isError: false,
      refetch: vi.fn(),
      activate: {
        mutateAsync: vi.fn().mockResolvedValue(community),
        isPending: false,
        reset: vi.fn(),
      },
      remove: {
        mutateAsync: vi.fn().mockResolvedValue(community),
        isPending: false,
        reset: vi.fn(),
      },
    };
    mocks.query.mockImplementation(() => query);
    mocks.user.mockReturnValue({
      data: { user: { role: "owner", workspaceId: community.workspaceId } },
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows Community status without claiming implemented Enterprise features", () => {
    show();
    expect(screen.getByText("Community — no license")).toBeTruthy();
    expect(
      screen.getByText(
        "No Enterprise capabilities are implemented in this build yet.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(community.workspaceId)).toBeTruthy();
  });
  it("does not fetch or expose license management to non-owners", () => {
    mocks.user.mockReturnValue({
      data: { user: { role: "admin", workspaceId: community.workspaceId } },
    });
    show();
    expect(mocks.query).toHaveBeenCalledWith(community.workspaceId, false);
    expect(screen.queryByLabelText("License")).toBeNull();
  });
  it("handles loading and unavailable status without showing a false edition", () => {
    query.isPending = true;
    query.data = undefined;
    const view = show();
    expect(screen.getByText("Loading license status…")).toBeTruthy();
    query.isPending = false;
    query.isError = true;
    view.rerender(
      <MantineProvider>
        <I18nextProvider i18n={i18n}>
          <LicenseManager />
        </I18nextProvider>
      </MantineProvider>,
    );
    expect(
      screen.getByText(
        "License status is unavailable. No licensing changes were made.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("License")).toBeNull();
  });
  it("clears submitted license material after successful activation", async () => {
    show();
    fireEvent.change(screen.getByLabelText("License"), {
      target: { value: " test-envelope " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install license" }));
    await waitFor(() =>
      expect(query.activate.mutateAsync).toHaveBeenCalledWith("test-envelope"),
    );
    await waitFor(() =>
      expect((screen.getByLabelText("License") as HTMLInputElement).value).toBe(
        "",
      ),
    );
    expect(query.activate.reset).toHaveBeenCalled();
  });
  it("shows safe activation errors without echoing key material", async () => {
    query.activate.mutateAsync.mockRejectedValue(
      new Error("sensitive-error-details"),
    );
    show();
    fireEvent.change(screen.getByLabelText("License"), {
      target: { value: "test-envelope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install license" }));
    expect(
      await screen.findByText(
        "License could not be installed. Check its workspace, validity and trusted issuer.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("sensitive-error-details")).toBeNull();
    expect(query.activate.reset).toHaveBeenCalled();
  });
  it("shows grace, expiry and seat warnings while preserving data assurances", () => {
    query.data = {
      ...community,
      edition: "enterprise",
      status: "grace",
      seats: { active: 3, limit: 2, overLimit: true },
    };
    show();
    expect(screen.getByText("Renewal grace period")).toBeTruthy();
    expect(
      screen.getByText(
        "Seat limit exceeded. Existing members are kept; additional activations are blocked while the license is active.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Licensing does not delete your content or disable existing security restrictions.",
      ),
    ).toBeTruthy();
  });
  it("requires explicit confirmation before removing a license", async () => {
    query.data = {
      ...community,
      status: "valid",
      license: {
        licenseId: "license-id",
        licensee: "Example",
        issuedAt: "2026-11-01T00:00:00Z",
        notBefore: "2026-11-01T00:00:00Z",
        expiresAt: "2026-12-01T00:00:00Z",
        graceEndsAt: "2026-12-31T00:00:00Z",
        capabilities: [],
      },
    };
    show();
    fireEvent.click(screen.getByRole("button", { name: "Remove license" }));
    expect(query.remove.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() =>
      expect(query.remove.mutateAsync).toHaveBeenCalledOnce(),
    );
  });
  it("allows an owner to remove an unverifiable stored license without metadata", async () => {
    query.data = { ...community, status: "invalid", trustConfigured: false };
    show();
    fireEvent.click(screen.getByRole("button", { name: "Remove license" }));
    expect(query.remove.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() =>
      expect(query.remove.mutateAsync).toHaveBeenCalledOnce(),
    );
  });
});
