import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface TodoEnvironment {
  mode: "development" | "production" | "test";
  token: string | undefined;
  dataSourceId: string | undefined;
  appPassword: string | undefined;
  sessionSecret: string | undefined;
  webhookVerificationToken: string | undefined;
  webOrigin: string;
  port: number;
  devBypassAuth: boolean;
  dataDirectory: string;
}

export function loadTodoEnvironment(mode: string): TodoEnvironment {
  loadEnv({ path: resolve(appDirectory, ".env"), quiet: true });
  if (process.env.NOTION_ENV_FILE) {
    loadEnv({
      path: resolve(appDirectory, process.env.NOTION_ENV_FILE),
      quiet: true,
    });
  }

  const normalizedMode = mode === "production" || mode === "test" ? mode : "development";
  const port = Number(process.env.PORT ?? 8790);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  return {
    mode: normalizedMode,
    token: process.env.NOTION_PAT ?? process.env.NOTION_TOKEN,
    dataSourceId: process.env.NOTION_DATA_SOURCE_ID ?? process.env.NOTION_DATABASE_ID,
    appPassword: process.env.APP_PASSWORD,
    sessionSecret: process.env.SESSION_SECRET,
    webhookVerificationToken: process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN,
    webOrigin: process.env.WEB_ORIGIN ?? `http://localhost:${port}`,
    port,
    devBypassAuth: process.env.DEV_BYPASS_AUTH === "true",
    dataDirectory: resolve(appDirectory, process.env.DATA_DIRECTORY ?? ".data"),
  };
}
