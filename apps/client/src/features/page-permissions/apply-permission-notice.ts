import type { QueryClient } from "@tanstack/react-query";
import type { IPage } from "@/features/page/types/page.types";

export function applyPermissionNotice(
  client: QueryClient,
  keys: readonly string[],
  access: unknown,
): void {
  if (!["none", "read", "write"].includes(access as string)) return;
  for (const key of new Set(keys)) {
    if (!key) continue;
    if (access === "none") {
      client
        .getQueryCache()
        .find({ queryKey: ["pages", key], exact: true })
        ?.setState({
          status: "error",
          fetchStatus: "idle",
          data: undefined,
          error: Object.assign(new Error("Forbidden"), { status: 403 }),
        });
    } else {
      client.setQueryData<IPage>(
        ["pages", key],
        (page) =>
          page && {
            ...page,
            permissions: { ...page.permissions, canEdit: access === "write" },
          },
      );
    }
  }
}
