/**
 * Minimal HTTP endpoint for the DM worker.
 *
 * The worker is a pure queue consumer with no inbound traffic, which is fine
 * on a plain VM but not on hosts that require a listening port (Render,
 * Koyeb web services, Fly) or that idle-stop a service that receives no
 * requests. Those platforms only count INBOUND HTTP as activity — the
 * worker's own outbound polling and Redis traffic do not keep it awake — so
 * an external pinger has to hit this endpoint on an interval shorter than the
 * host's idle timeout.
 *
 * Deliberately started only when PORT (or WORKER_HEALTH_PORT) is set, so
 * running the worker locally or on a VM binds nothing and behaves exactly as
 * before.
 *
 * This reports the LOCAL process only. It is not a substitute for the app's
 * /api/health, which additionally checks that the heartbeat reached Redis —
 * the thing that actually proves web and worker share a datastore.
 */
import { createServer, type Server } from "node:http";
import os from "node:os";

interface HealthServerOptions {
  /** False once BullMQ has stopped consuming, so a stuck worker fails its ping. */
  isHealthy: () => boolean;
  startedAt: string;
}

export function startHealthServer({
  isHealthy,
  startedAt,
}: HealthServerOptions): Server | null {
  const configured = process.env.WORKER_HEALTH_PORT ?? process.env.PORT;
  if (!configured) return null;

  const port = Number(configured);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`[DM Worker] Ignoring invalid health port: ${configured}`);
    return null;
  }

  const server = createServer((req, res) => {
    // Answer every path, not just /health: uptime monitors and platform health
    // checks default to "/", and a 404 there reads as down.
    const healthy = isHealthy();
    res.writeHead(healthy ? 200 : 503, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(
      JSON.stringify({
        status: healthy ? "ok" : "degraded",
        worker: "dm",
        pid: process.pid,
        hostname: os.hostname(),
        startedAt,
        uptimeSeconds: Math.round(process.uptime()),
      })
    );
  });

  server.on("error", (error) => {
    console.error("[DM Worker] Health server error:", error.message);
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[DM Worker] Health endpoint listening on 0.0.0.0:${port}`);
  });

  return server;
}
