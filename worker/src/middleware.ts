import type { MiddlewareHandler } from "hono";
import type { AppType } from "./types";
import { verifyJwt, parseCookie } from "./jwt";

export function authMiddleware(): MiddlewareHandler<AppType> {
  return async (c, next) => {
    const cookieHeader = c.req.header("Cookie");
    const token = parseCookie(cookieHeader, "session");

    if (!token) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const payload = await verifyJwt(token, c.env.JWT_SECRET);
    if (!payload) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    c.set("user", payload);
    await next();
  };
}
