import { Hono } from "hono";
import type { AppType } from "./types";
import { handleProxy } from "./proxy";
import { authRoutes } from "./auth";
import { serverRoutes } from "./servers";
import { authMiddleware } from "./middleware";

const app = new Hono<AppType>();

app.route("/api/auth", authRoutes);

app.use("/api/servers/*", authMiddleware());
app.route("/api/servers", serverRoutes);

app.use("/proxy", authMiddleware());
app.get("/proxy", handleProxy);

export default app;
