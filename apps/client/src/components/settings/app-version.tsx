import { useAppVersion } from "@/features/workspace/queries/workspace-query.ts";
import { getAppName, isCloud } from "@/lib/config.ts";
import classes from "@/components/settings/settings.module.css";
import { Text } from "@mantine/core";
import React from "react";
import { useTranslation } from "react-i18next";

export default function AppVersion() {
  const { t } = useTranslation();
  const appName = getAppName();
  const { data: appVersion } = useAppVersion(!isCloud());

  return (
    <div className={classes.text}>
      <Text size="sm" c="dimmed">
        {appVersion?.currentVersion
          ? t("{{appName}} — base v{{version}}", {
              appName,
              version: appVersion.currentVersion,
            })
          : appName}
      </Text>
    </div>
  );
}
