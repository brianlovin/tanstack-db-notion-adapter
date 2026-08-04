import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTodoApi } from "./server/app";
import { loadTodoEnvironment } from "./server/environment";

const environment = loadTodoEnvironment(process.env.NODE_ENV ?? "production");
const app = await createTodoApi(environment);
const distributionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "dist");

app.use("*", serveStatic({ root: distributionDirectory }));
app.get("*", serveStatic({ path: resolve(distributionDirectory, "index.html") }));

serve({ fetch: app.fetch, port: environment.port }, () => {
  console.log(`Daylight is listening on http://localhost:${environment.port}`);
});
