import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useAuth from "./use-auth";
import APP_ROUTE from "@/lib/app-route";

const { reset, navigate, notify, logout, cleanupCache } = vi.hoisted(() => ({
  reset: vi.fn(),
  navigate: vi.fn(),
  notify: vi.fn(),
  logout: vi.fn(),
  cleanupCache: vi.fn(),
}));

vi.mock("@/features/auth/services/auth-service", () => ({
  passwordReset: reset,
  forgotPassword: vi.fn(),
  login: vi.fn(),
  logout,
  setupWorkspace: vi.fn(),
  verifyUserToken: vi.fn(),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: notify } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (text: string) => text }),
}));
vi.mock("@/features/workspace/services/workspace-service.ts", () => ({
  acceptInvitation: vi.fn(),
  createWorkspace: vi.fn(),
}));
vi.mock("@/lib/config.ts", () => ({ isCloud: () => false }));
vi.mock("@/lib/local-page-data.ts", () => ({
  deleteLocalPageData: cleanupCache,
}));
vi.mock("@/ee/utils.ts", () => ({
  exchangeTokenRedirectUrl: vi.fn(),
  getHostnameUrl: vi.fn(),
}));

const input = {
  token: "synthetic-reset-link",
  newPassword: "synthetic-password",
};

describe("Password reset sign-in handoff", () => {
  beforeEach(() => {
    reset.mockReset();
    navigate.mockReset();
    notify.mockReset();
  });
  afterEach(cleanup);

  it.each([{ requiresLogin: true }, { requiresLogin: false }, undefined])(
    "requires normal sign-in after any successful reset response: %j",
    async (response) => {
      reset.mockResolvedValue(response);
      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await result.current.passwordReset(input);
      });
      expect(reset).toHaveBeenCalledWith(input);
      expect(navigate).toHaveBeenCalledWith(APP_ROUTE.AUTH.LOGIN);
      expect(navigate).not.toHaveBeenCalledWith(APP_ROUTE.HOME);
      expect(notify).toHaveBeenCalledWith({
        message: "Password reset was successful. Please sign in again.",
      });
      expect(result.current.isLoading).toBe(false);
    },
  );

  it("does not navigate after a rejected reset", async () => {
    reset.mockRejectedValue({
      response: { data: { message: "Invalid or expired token" } },
    });
    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.passwordReset(input);
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith({
      message: "Invalid or expired token",
      color: "red",
    });
    expect(result.current.isLoading).toBe(false);
  });

  it("keeps loading until the reset request settles", async () => {
    let resolve!: (value: unknown) => void;
    reset.mockImplementation(
      () =>
        new Promise((ready) => {
          resolve = ready;
        }),
    );
    const { result } = renderHook(() => useAuth());
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.passwordReset(input);
    });
    expect(result.current.isLoading).toBe(true);
    await act(async () => {
      resolve({ requiresLogin: true });
      await pending;
    });
    expect(result.current.isLoading).toBe(false);
  });
});

describe("Logout", () => {
  const replace = vi.fn();
  beforeEach(() => {
    logout.mockReset();
    cleanupCache.mockReset();
    notify.mockReset();
    replace.mockReset();
    vi.stubGlobal("location", { ...window.location, replace });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("revokes the server session before local cache cleanup", async () => {
    const order: string[] = [];
    logout.mockImplementation(async () => order.push("server"));
    cleanupCache.mockImplementation(async () => order.push("cache"));
    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.logout();
    });
    expect(order).toEqual(["server", "cache"]);
    expect(replace).toHaveBeenCalledWith(`${APP_ROUTE.AUTH.LOGIN}?logout=1`);
  });

  it("sends the server logout even when cache cleanup never settles", async () => {
    cleanupCache.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAuth());
    act(() => {
      void result.current.logout();
    });
    await vi.waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });

  it("does not report a signed-out state when server logout fails", async () => {
    logout.mockRejectedValue({ response: { status: 500 } });
    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.logout();
    });
    expect(replace).not.toHaveBeenCalled();
    expect(cleanupCache).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ color: "red" }),
    );
  });

  it("treats an already-invalid session as signed out", async () => {
    logout.mockRejectedValue({ response: { status: 401 } });
    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.logout();
    });
    expect(replace).toHaveBeenCalledWith(`${APP_ROUTE.AUTH.LOGIN}?logout=1`);
  });
});
