import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api-client.ts";
import type { AuditHistoryPage, AuditHistoryParams } from "../types/audit.types.ts";

export function useAuditHistory(
  workspaceId: string | undefined,
  isOwner: boolean,
  params: AuditHistoryParams,
) {
  return useQuery({
    queryKey: ["wikisavvy-audit", workspaceId, params],
    enabled: Boolean(workspaceId) && isOwner,
    retry: false,
    refetchInterval: 30_000,
    queryFn: async (): Promise<AuditHistoryPage> => {
      try {
        const response = await api.post("/wikisavvy/audit/history", params);
        return response.data;
      } catch {
        throw new Error("Audit history could not be loaded");
      }
    },
  });
}
