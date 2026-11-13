import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:5080",
    },
  },
  build: {
    // Build straight into the API so one `dotnet run` serves everything.
    outDir: "../Lifetime.Api/wwwroot",
    emptyOutDir: true,
  },
});
