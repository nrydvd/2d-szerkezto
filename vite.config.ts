import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

function designerRoutesPlugin(): Plugin {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    const url = req.url ?? "";
    const match = /^\/(szerkeszto|termekek)\/[a-z0-9][a-z0-9-]*\/?(\?.*)?$/.exec(url);
    if (match) req.url = `/${match[1]}/index.html${match[2] ?? ""}`;
    next();
  };
  return {
    name: "roli-designer-routes",
    configureServer(server) { server.middlewares.use(rewrite); },
    configurePreviewServer(server) { server.middlewares.use(rewrite); },
  };
}

export default defineConfig({
  plugins: [designerRoutesPlugin(), react()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(projectRoot, "index.html"),
        designer: path.resolve(projectRoot, "szerkeszto/index.html"),
        designerAdmin: path.resolve(projectRoot, "termekek/index.html"),
      },
    },
  },
});
