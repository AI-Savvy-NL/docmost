import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LicenseStatus } from "@wikisavvy/license";
import api from "@/lib/api-client.ts";

async function requestStatus(
  action: string,
  license?: string,
): Promise<LicenseStatus> {
  try {
    const result = await api.post(
      `/wikisavvy/licensing/${action}`,
      license === undefined ? {} : { license },
    );
    return result.data;
  } catch {
    throw new Error("WikiSavvy licensing request could not be completed");
  }
}

export function useWikisavvyLicense(
  workspaceId: string | undefined,
  isOwner: boolean,
) {
  const client = useQueryClient();
  const queryKey = ["wikisavvy-license", workspaceId];
  const query = useQuery({
    queryKey,
    queryFn: () => requestStatus("status"),
    enabled: Boolean(workspaceId) && isOwner,
    retry: false,
    refetchInterval: 60000,
  });
  const onSuccess = (data: LicenseStatus) =>
    client.setQueryData(queryKey, data);
  const activate = useMutation({
    mutationFn: (license: string) => requestStatus("activate", license),
    onSuccess,
  });
  const remove = useMutation({
    mutationFn: () => requestStatus("remove"),
    onSuccess,
  });
  return { ...query, activate, remove };
}
