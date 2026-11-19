import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { HelmetProvider } from "react-helmet-async";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import Security from "./security";
import { useGetScimTokensQuery } from "@/ee/scim/queries/scim-token-query";

const state = vi.hoisted(() => ({
  admin: true,
  owner: true,
  features: [] as string[],
  status: vi.fn(),
  legacy: vi.fn(),
  scim: vi.fn(),
}));
vi.mock("@/hooks/use-user-role.tsx", () => ({
  default: () => ({ isAdmin: state.admin, isOwner: state.owner }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (value: string) => value,
    i18n: { language: "en-US" },
  }),
}));
vi.mock("@/i18n.ts", () => ({ default: { language: "en-US" } }));
vi.mock("@/ee/hooks/use-feature", () => ({
  useHasFeature: (feature: string) => state.features.includes(feature),
}));
vi.mock("@/ee/hooks/use-feature.ts", () => ({
  useHasFeature: (feature: string) => state.features.includes(feature),
}));
vi.mock("@/features/oidc/oidc-service", () => ({
  getOidcStatus: state.status,
}));
vi.mock("@/ee/security/queries/security-query.ts", () => ({
  useGetSsoProviders: state.legacy,
  useDeleteSsoProviderMutation: () => ({}),
}));
vi.mock("@/ee/scim/services/scim-token-service", () => ({
  getScimTokens: state.scim,
  createScimToken: vi.fn(),
  revokeScimToken: vi.fn(),
  updateScimToken: vi.fn(),
}));
function show() {
  const store = createStore();
  store.set(currentUserAtom, {
    user: {},
    workspace: {
      settings: {},
      enforceSso: false,
      enforceMfa: false,
      isScimEnabled: false,
    },
  } as never);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <HelmetProvider>
      <MantineProvider>
        <Provider store={store}>
          <QueryClientProvider client={client}>
            <Security />
          </QueryClientProvider>
        </Provider>
      </MantineProvider>
    </HelmetProvider>,
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
  vi.clearAllMocks();
  state.admin = true;
  state.owner = true;
  state.features = [];
  state.status.mockImplementation(async () => ({
    canManage: state.owner,
    providers: [],
    callbackUrl: "https://wiki.example.invalid/api/oidc/callback",
  }));
  state.legacy.mockReturnValue({ data: { items: [] }, isLoading: false });
  state.scim.mockResolvedValue({ items: [] });
});
afterEach(cleanup);
describe("Security page independent SSO placement", () => {
  it("preserves the entitled legacy provider list alongside independent controls", async () => {
    state.features = ["security:settings"];
    show();
    expect(
      await screen.findByRole("button", { name: "Configure SSO provider" }),
    ).toBeTruthy();
    expect(state.legacy).toHaveBeenCalled();
    expect(state.scim).not.toHaveBeenCalled();
  });
  it("preserves explicitly enabled SCIM fetching while suppressing disabled queries", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let enabled = false;
    const hook = renderHook(() => useGetScimTokensQuery(undefined, enabled), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    expect(state.scim).not.toHaveBeenCalled();
    enabled = true;
    hook.rerender();
    await waitFor(() => expect(state.scim).toHaveBeenCalledTimes(1));
  });
  it("renders owner provider configuration in the existing security page without paid API calls", async () => {
    show();
    expect(
      await screen.findByRole("button", { name: "Configure SSO provider" }),
    ).toBeTruthy();
    expect(state.legacy).not.toHaveBeenCalled();
    expect(state.scim).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole("switch", {
          name: "Toggle sso enforcement",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Link account" })).toBeNull();
  });
  it("does not start SCIM queries without an implemented entitlement", async () => {
    show();
    await waitFor(() => expect(state.scim).not.toHaveBeenCalled());
  });
  it("does not offer provider configuration to a non-owner administrator", async () => {
    state.owner = false;
    show();
    expect(
      await screen.findByText(
        "Only the workspace owner can manage SSO providers.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Configure SSO provider" }),
    ).toBeNull();
  });
  it("does not render security administration or fetch provider data for a member", () => {
    state.owner = false;
    state.admin = false;
    show();
    expect(screen.queryByText("Single sign-on (SSO)")).toBeNull();
    expect(state.status).not.toHaveBeenCalled();
    expect(state.scim).not.toHaveBeenCalled();
  });
});
