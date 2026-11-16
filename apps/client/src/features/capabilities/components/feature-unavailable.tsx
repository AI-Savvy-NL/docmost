import { Alert, Stack, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { getAppName } from "@/lib/config.ts";

export default function FeatureUnavailable({ feature }: { feature: string }) {
  const { t } = useTranslation();
  return (
    <Stack gap="md" p="md">
      <DocumentTitle title={t(feature)} />
      <Title order={2}>{t(feature)}</Title>
      <Alert color="blue" title={t("Not implemented yet")}>
        {t("This feature is not implemented in {{appName}} yet.", {
          appName: getAppName(),
        })}
      </Alert>
      <Text c="dimmed" size="sm">
        {t("Opening this page does not change your data or security settings.")}
      </Text>
    </Stack>
  );
}
