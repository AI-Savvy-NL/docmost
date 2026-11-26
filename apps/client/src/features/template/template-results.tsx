import { useInfiniteQuery } from "@tanstack/react-query";
import { Alert, Button, Loader, Paper, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { listTemplates, TemplateRecord } from "./template-api";

export function TemplateResults({
  onChoose,
}: {
  onChoose: (template: TemplateRecord) => void;
}) {
  const { t } = useTranslation();
  const query = useInfiniteQuery({
    queryKey: ["templates", "workspace"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => listTemplates({ limit: 20, cursor: pageParam }),
    getNextPageParam: (page) =>
      page.meta.hasNextPage ? (page.meta.nextCursor ?? undefined) : undefined,
  });
  if (query.isPending)
    return (
      <div role="status" aria-label={t("Loading templates")}>
        <Loader size="sm" />
      </div>
    );
  if (query.isError && !query.data)
    return (
      <Alert color="red" role="alert">
        {t("Failed to load templates")}
        <Button variant="subtle" onClick={() => void query.refetch()}>
          {t("Retry")}
        </Button>
      </Alert>
    );
  const templates = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Stack>
      {!templates.length && <Text c="dimmed">{t("No templates yet")}</Text>}
      {templates.map((template) => (
        <Paper key={template.id} withBorder p="sm">
          <Button variant="subtle" onClick={() => onChoose(template)}>
            {template.title || t("Untitled")}
          </Button>
          {template.description && (
            <Text size="sm" c="dimmed">
              {template.description}
            </Text>
          )}
        </Paper>
      ))}
      {query.isFetchNextPageError && (
        <Alert color="red" role="alert">
          {t("Failed to load more templates")}
        </Alert>
      )}
      {query.hasNextPage && (
        <Button
          variant="default"
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t("Load more")}
        </Button>
      )}
    </Stack>
  );
}
