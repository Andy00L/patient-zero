import { connection } from "next/server";

import { type LoadedGraph, loadGraph } from "@/lib/graph/load-graph";
import type { Failure, Result } from "@/lib/result";

/**
 * The graph, for a server render.
 *
 * `loadGraph` is framework free on purpose: it is the same function a script, a test, and a
 * route handler call. This wrapper is the one place that knows it is inside Next, and it exists
 * for a single reason. A server component that reads a snapshot off disk completes that read
 * during prerendering, so the coverage numbers in the status rail and the answers on every
 * surface would be baked into the build and would keep reporting a slice that had since been
 * replaced by a new ingest. `connection()` is the documented way to say "wait for a request"
 * (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/connection.md, whose own
 * example is a synchronous database driver), so every surface reads the graph that is on disk
 * now rather than the one that was there when the build ran.
 *
 * Route handlers call `loadGraph` directly. A handler already runs per request, so it needs
 * nothing from this file.
 */
export async function requestGraph(): Promise<Result<LoadedGraph, Failure>> {
  await connection();
  return loadGraph();
}
