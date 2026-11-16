import { Anchor, Stack, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { getAppName } from "@/lib/config.ts";
import LicenseManager from "@/features/licensing/components/license-manager.tsx";

export default function LicenseEdition() {
  const { t } = useTranslation();

  return (
    <>
      <DocumentTitle title={t("License & Edition")} />
      <SettingsTitle title={t("License & Edition")} />
      <Stack gap="md">
        <Title order={2} size="h4">
          {getAppName()}
        </Title>
        <LicenseManager />
        <Stack gap="xs">
          <Text fw={500}>{t("Core license")}</Text>
          <Text>
            {t(
              "The core application code is licensed under the AGPL-3.0 license.",
            )}
          </Text>
          <Anchor
            href="https://www.gnu.org/licenses/agpl-3.0.html"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("GNU Affero General Public License v3.0 (AGPL-3.0)")}
          </Anchor>
        </Stack>
        <Text>
          {t("Third-party components retain their respective licenses.")}
        </Text>
        <Text c="dimmed" size="sm">
          {t("Existing copyright and license notices remain applicable.")}
        </Text>
      </Stack>
    </>
  );
}
