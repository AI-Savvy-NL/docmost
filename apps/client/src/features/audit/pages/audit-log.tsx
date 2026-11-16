import { useEffect, useState } from "react";
import { Alert, Button, Group, Stack, Table, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import useCurrentUser from "@/features/user/hooks/use-current-user.ts";
import { UserRole } from "@/lib/types.ts";
import { useAuditHistory } from "../queries/audit-query.ts";

export default function AuditLog() {
  const { t } = useTranslation();
  const { data: currentUser, isPending: userLoading } = useCurrentUser();
  const workspaceId = currentUser?.user?.workspaceId;
  const isOwner = currentUser?.user?.role === UserRole.OWNER;
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  useEffect(() => setCursors([undefined]), [workspaceId]);
  const { data, isPending, isError, isFetching, refetch } = useAuditHistory(
    workspaceId, isOwner, { limit: 50, cursor: cursors[cursors.length - 1] },
  );
  if (userLoading) return <Text>{t("Loading audit history…")}</Text>;
  if (!isOwner) return <Text>{t("Only workspace owners can view audit history.")}</Text>;
  if (isPending) return <Text>{t("Loading audit history…")}</Text>;
  if (isError || !data) return (
    <Alert color="yellow">
      <Text>{t("Audit history is unavailable.")}</Text>
      <Button variant="subtle" onClick={() => refetch()}>{t("Retry")}</Button>
    </Alert>
  );
  const hasFailure = data.captureStatus.failed > 0 || data.captureStatus.rejected > 0;
  const previous = () => setCursors((value) => value.slice(0, -1));
  const next = () => {
    if (data.meta.nextCursor) setCursors((value) => [...value, data.meta.nextCursor!]);
  };
  return (
    <Stack gap="md">
      <DocumentTitle title={t("Audit logs")} />
      <SettingsTitle title={t("Audit logs")} />
      <Text size="sm" c="dimmed">
        {t("This view shows event and resource identifiers, not document content or credentials.")}
      </Text>
      <Text size="sm">{t("Audit capture is best effort. Counters cover this server process only.")}</Text>
      {hasFailure && (
        <Alert color="yellow">
          {t("Some audit events could not be recorded. Counters cover this server process only.")}
        </Alert>
      )}
      <Group justify="flex-end">
        <Button variant="default" loading={isFetching} onClick={() => refetch()}>{t("Refresh")}</Button>
      </Group>
      {!data.items.length ? <Text>{t("No audit events have been recorded yet.")}</Text> : (
        <Table.ScrollContainer minWidth={720}>
          <Table>
            <Table.Thead><Table.Tr>
              <Table.Th>{t("Recorded at")}</Table.Th>
              <Table.Th>{t("Event")}</Table.Th>
              <Table.Th>{t("Actor")}</Table.Th>
              <Table.Th>{t("Resource")}</Table.Th>
              <Table.Th>{t("Resource ID")}</Table.Th>
            </Table.Tr></Table.Thead>
            <Table.Tbody>
              {data.items.map((row) => (
                <Table.Tr key={row.id}>
                  <Table.Td><time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</time></Table.Td>
                  <Table.Td>{row.event}</Table.Td>
                  <Table.Td>{row.actorId ?? t(row.actorType === "system" ? "System" : "Unknown actor")}</Table.Td>
                  <Table.Td>{row.resourceType}</Table.Td>
                  <Table.Td>{row.resourceId ?? "—"}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <Group justify="space-between">
        <Button variant="default" disabled={cursors.length <= 1 || isFetching} onClick={previous}>{t("Previous")}</Button>
        <Button variant="default" disabled={!data.meta.hasNextPage || !data.meta.nextCursor || isFetching} onClick={next}>{t("Next")}</Button>
      </Group>
    </Stack>
  );
}
