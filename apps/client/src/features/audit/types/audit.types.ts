export type AuditHistoryItem = {
  id: string;
  createdAt: string;
  event: string;
  actorId: string | null;
  actorType: string;
  resourceType: string;
  resourceId: string | null;
  spaceId: string | null;
};

export type AuditHistoryParams = { limit: number; cursor?: string };

export type AuditHistoryPage = {
  items: AuditHistoryItem[];
  meta: {
    limit: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
    nextCursor: string | null;
    prevCursor: string | null;
  };
  captureStatus: {
    scope: "server-process";
    startedAt: string;
    recorded: number;
    rejected: number;
    failed: number;
    lastFailureAt: string | null;
  };
};
