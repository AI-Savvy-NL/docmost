import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import PagePermissionsModal from "./page-permissions-modal";
import type { PagePermissionState } from "./page-permission-api";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api-client.ts", () => ({ default: { post: mocks.post } }));
const i18n = createInstance();
const pageId = "11111111-1111-4111-8111-111111111111";
const alex = "22222222-2222-4222-8222-222222222222";
const blair = "33333333-3333-4333-8333-333333333333";
const initial: PagePermissionState = {
  pageId,
  revision: "a".repeat(64),
  hasDirectRestriction: true,
  inheritedPageId: null,
  canCreateRestriction: false,
  grants: [
    {
      type: "user",
      id: alex,
      name: "Alex",
      email: "alex@example.invalid",
      role: "writer",
    },
  ],
};
let state: PagePermissionState;
let client: QueryClient;
const close = vi.fn();
const rejected = (status: number) => ({
  isAxiosError: true,
  response: { status },
  message: "private-server-details",
});

function show(opened = true) {
  return render(
    <QueryClientProvider client={client}>
      <MantineProvider>
        <I18nextProvider i18n={i18n}>
          <PagePermissionsModal
            pageId={pageId}
            opened={opened}
            onClose={close}
          />
        </I18nextProvider>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

describe("Independent page permissions modal", () => {
  beforeAll(async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi
        .fn()
        .mockReturnValue({
          matches: false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }),
    });
    await i18n.init({ lng: "en", resources: { en: { translation: {} } } });
  });
  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    state = structuredClone(initial);
    close.mockReset();
    mocks.post.mockReset().mockImplementation(async (path: string) => ({
      data: path.endsWith("/principals")
        ? [
            {
              type: "user",
              id: alex,
              name: "Alex",
              email: "alex@example.invalid",
            },
            {
              type: "user",
              id: blair,
              name: "Blair",
              email: "blair@example.invalid",
            },
          ]
        : state,
    }));
  });
  afterEach(() => {
    cleanup();
    client.clear();
  });

  it("does not fetch permission state while closed", () => {
    show(false);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("announces loading without showing cached editing controls", async () => {
    mocks.post.mockReturnValue(new Promise(() => {}));
    show();
    expect(await screen.findByText("Loading page permissions…")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save permissions" }),
    ).toBeNull();
  });
  it("explains inherited restrictions and creation-only licensing", async () => {
    state = {
      ...state,
      hasDirectRestriction: false,
      inheritedPageId: pageId,
      grants: [],
    };
    show();
    expect(
      await screen.findByText(
        "This page inherits restrictions from an ancestor.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "A valid WikiSavvy license is required to add a direct restriction.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restrict page" })).toBeNull();
  });
  it("keeps existing restriction controls available without a new-restriction entitlement", async () => {
    show();
    expect(await screen.findByLabelText("Role for Alex")).toBeTruthy();
    expect(
      (screen.getByLabelText("Role for Alex") as HTMLSelectElement).disabled,
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: "Remove restriction…" }),
    ).toBeTruthy();
  });
  it("selects a principal and submits the original revision with explicit roles", async () => {
    show();
    const select = await screen.findByLabelText("Person or group");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Blair" })).toBeTruthy(),
    );
    fireEvent.change(select, { target: { value: `user:${blair}` } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByLabelText("Role for Blair")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Role for Blair"), {
      target: { value: "writer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save permissions" }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        "/wikisavvy/page-permissions/set",
        {
          pageId,
          revision: initial.revision,
          grants: [
            { type: "user", id: alex, role: "writer" },
            { type: "user", id: blair, role: "writer" },
          ],
        },
      ),
    );
    await waitFor(() => expect(close).toHaveBeenCalled());
  });
  it("does not silently overwrite a conflict or expose raw error details", async () => {
    state.grants.push({
      type: "user",
      id: blair,
      name: "Blair",
      email: null,
      role: "reader",
    });
    mocks.post.mockImplementation(async (path: string) => {
      if (path.endsWith("/set")) throw rejected(409);
      return { data: path.endsWith("/principals") ? [] : state };
    });
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove Blair" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save permissions" }));
    expect(
      await screen.findByText(
        "Permissions changed or a page would lose its last writer. Reload and review your changes.",
      ),
    ).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByText("private-server-details")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Reload permissions" }),
    ).toBeTruthy();
  });
  it("prevents submitting a list with no writer", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Alex" }));
    expect(
      (
        screen.getByRole("button", {
          name: "Save permissions",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("hides stale grant data when a fresh management check is denied", async () => {
    client.setQueryData(["wikisavvy-page-permissions", pageId], state);
    mocks.post.mockRejectedValue(rejected(403));
    show();
    expect(
      await screen.findByText(
        "You no longer have permission to manage this page.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Role for Alex")).toBeNull();
  });
  it("hides editing controls immediately when a mutation loses authorization", async () => {
    state.grants.push({
      type: "user",
      id: blair,
      name: "Blair",
      email: null,
      role: "reader",
    });
    mocks.post.mockImplementation(async (path: string) => {
      if (path.endsWith("/set")) throw rejected(403);
      return { data: path.endsWith("/principals") ? [] : state };
    });
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove Blair" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save permissions" }));
    expect(
      await screen.findByText(
        "You no longer have permission to manage this page.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save permissions" }),
    ).toBeNull();
  });
  it("requires confirmation before removing a direct restriction", async () => {
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove restriction…" }),
    );
    expect(
      mocks.post.mock.calls.some(([path]) => path.endsWith("/remove")),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove direct restriction" }),
    );
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        "/wikisavvy/page-permissions/remove",
        {
          pageId,
          revision: initial.revision,
        },
      ),
    );
  });
  it("can create a licensed direct restriction with an explicitly selected writer", async () => {
    state = {
      ...state,
      hasDirectRestriction: false,
      canCreateRestriction: true,
      grants: [],
    };
    show();
    const select = await screen.findByLabelText("Person or group");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Alex" })).toBeTruthy(),
    );
    fireEvent.change(select, { target: { value: `user:${alex}` } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(await screen.findByLabelText("Role for Alex"), {
      target: { value: "writer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Restrict page" }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        "/wikisavvy/page-permissions/set",
        {
          pageId,
          revision: initial.revision,
          grants: [{ type: "user", id: alex, role: "writer" }],
        },
      ),
    );
  });
  it("hides controls when principal search discovers lost management access", async () => {
    mocks.post.mockImplementation(async (path: string) => {
      if (path.endsWith("/principals")) throw rejected(403);
      return { data: state };
    });
    show();
    expect(
      await screen.findByText(
        "You no longer have permission to manage this page.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Role for Alex")).toBeNull();
  });
  it("prevents dismissing or duplicating a pending mutation", async () => {
    state.grants.push({
      type: "user",
      id: blair,
      name: "Blair",
      email: null,
      role: "reader",
    });
    mocks.post.mockImplementation((path: string) => {
      if (path.endsWith("/set")) return new Promise(() => {});
      return Promise.resolve({
        data: path.endsWith("/principals") ? [] : state,
      });
    });
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove Blair" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save permissions" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    expect(
      mocks.post.mock.calls.filter(([path]) => path.endsWith("/set")),
    ).toHaveLength(1);
  });
});
