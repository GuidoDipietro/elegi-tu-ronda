import { createServer } from "vite";
import { handle } from "../src/server/handler.ts";
const vite = await createServer({
  plugins: [
    {
      name: "planner-api",
      configureServer(server) {
        server.middlewares.use("/api/planner", async (req, res) => {
          try {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > 200_000) {
                res.statusCode = 413;
                res.end("Request too large");
                return;
              }
              chunks.push(Buffer.from(chunk));
            }
            const url = `http://${req.headers.host}/api/planner${req.url || ""}`;
            const headers = new Headers();
            for (const [key, value] of Object.entries(req.headers))
              if (value)
                headers.set(
                  key,
                  Array.isArray(value) ? value.join(", ") : value,
                );
            const request = new Request(url, {
              method: req.method,
              headers,
              ...(req.method !== "GET" && req.method !== "HEAD"
                ? { body: Buffer.concat(chunks) }
                : {}),
            });
            const response = await handle(request);
            res.statusCode = response.status;
            response.headers.forEach((value, key) => res.setHeader(key, value));
            res.end(await response.text());
          } catch {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "Error del servidor local." }));
          }
        });
      },
    },
  ],
});
await vite.listen();
vite.printUrls();
