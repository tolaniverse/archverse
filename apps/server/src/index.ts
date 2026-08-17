import { app } from "./app";

if (import.meta.main) {
  const port = Number(Bun.env.PORT ?? 3000);
  app.listen({ hostname: "0.0.0.0", port });
  console.log(`Archverse server listening on http://0.0.0.0:${port}`);
}

export { app };
