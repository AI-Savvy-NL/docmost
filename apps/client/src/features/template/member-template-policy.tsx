import { Badge, Group, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

export default function MemberTemplatePolicy() {
  const { t } = useTranslation();
  return (
    <Group justify="space-between" wrap="nowrap" gap="xl">
      <div>
        <Text size="md">{t("Allow members to create templates")}</Text>
        <Text size="sm" c="dimmed">
          {t(
            "All members can create workspace templates. Only authors and workspace admins can manage them.",
          )}
        </Text>
      </div>
      <Badge>{t("Enabled")}</Badge>
    </Group>
  );
}
