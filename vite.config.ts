import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    tanstackStart({
      // Redirect TanStack Start's bundled server entry to our SSR error wrapper.
      server: { entry: "server" },
    }),
    nitro({ preset: "vercel" }),
    react(),
    tailwindcss(),
    tsConfigPaths(),
  ],
  // patchright + its native chromium driver must NOT be bundled by Vite/Nitro SSR.
  // Keep them as runtime requires on the server (they're only imported inside
  // server functions, never in the client). This fixes the chromium-bidi resolve error.
  ssr: {
    external: ["patchright", "patchright-core", "playwright", "playwright-core", "chromium-bidi"],
  },
  optimizeDeps: {
    exclude: ["patchright", "patchright-core", "playwright", "playwright-core", "chromium-bidi"],
  },
});
