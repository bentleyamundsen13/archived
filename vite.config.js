import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split the big, rarely-changing libraries into their own chunks.
        // They cache in the browser across deploys, so when we ship an app
        // change users only re-download the small app chunk — faster loads
        // and less bandwidth.
        manualChunks: {
          firebase: [
            "firebase/app",
            "firebase/auth",
            "firebase/firestore",
          ],
          react: ["react", "react-dom"],
        },
      },
    },
  },
});
