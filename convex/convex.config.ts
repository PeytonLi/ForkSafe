import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import workflow from "@convex-dev/workflow/convex.config.js";
import workpool from "@convex-dev/workpool/convex.config.js";

const app = defineApp();
app.use(staticHosting);
app.use(workflow);
app.use(workpool, { name: "daytonaPool" });
app.use(workpool, { name: "outboxPool" });

export default app;
