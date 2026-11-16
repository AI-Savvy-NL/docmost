import clsx from "clsx";
import styles from "./docs.module.css";
import { getAppName } from "@/lib/config.ts";
import { useTranslation } from "react-i18next";

export default function DocsFooterBranding({
  className,
}: {
  className?: string;
  refSource?: string;
}) {
  const { t } = useTranslation();
  return (
    <footer className={clsx(styles.footer, className)}>
      <span className={styles.footerBranding}>
        {t("Powered by {{appName}}", { appName: getAppName() })}
      </span>
    </footer>
  );
}
