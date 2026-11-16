import React from "react";
import { Group, Text } from "@mantine/core";
import { MAIN_CONTENT_ID } from "@/components/ui/skip-to-main.tsx";
import { getAppName } from "@/lib/config.ts";
import AnnouncementBanners from "@/ee/announcement/components/announcement-banners.tsx";
import classes from "./auth.module.css";

type AuthLayoutProps = {
  children: React.ReactNode;
};

export function AuthLayout({ children }: AuthLayoutProps) {
  const appName = getAppName();

  return (
    <>
      <AnnouncementBanners surface="public" />
      <Group justify="center" gap={8} className={classes.logo}>
        <Text size="28px" fw={700} style={{ userSelect: "none" }}>
          {appName}
        </Text>
      </Group>
      <main id={MAIN_CONTENT_ID} tabIndex={-1}>{children}</main>
    </>
  );
}
