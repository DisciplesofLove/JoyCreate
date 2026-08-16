import fs from "fs";
import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Resolves bare, extensionless `@noble/hashes/<sub>` imports (e.g.
 * `@noble/hashes/utils`) to the physical ESM file on disk, bypassing the
 * package `exports` map.
 *
 * The libp2p stack (pulled into the renderer via Helia) imports
 * `@noble/hashes/utils` without a `.js` extension, but ships @noble/hashes v2
 * whose `exports` only expose the extensioned `./utils.js` subpath. Meanwhile
 * older v1.3.x/1.4.x copies (via ethers/ethereum-cryptography) expose only the
 * bare `./utils`. No single string rewrite satisfies both, so we resolve the
 * real file per-importer instead.
 */
function nobleHashesBareSubpath(): Plugin {
  const PKG = ["node_modules", "@noble", "hashes"];
  return {
    name: "noble-hashes-bare-subpath",
    enforce: "pre",
    resolveId(source, importer) {
      const match = source.match(/^@noble\/hashes\/([^./][^/]*)$/);
      if (!match || !importer) return null;
      const sub = match[1];

      // Walk up from the importer to find the nearest node_modules/@noble/hashes.
      let dir = path.dirname(importer.split("?")[0]);
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pkgDir = path.join(dir, ...PKG);
        if (fs.existsSync(pkgDir)) {
          let isEsmPkg = false;
          try {
            const pkgJson = JSON.parse(
              fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"),
            );
            isEsmPkg = pkgJson.type === "module";
          } catch {
            // ignore — treat as CJS layout below
          }
          // ESM-native packages (v2) keep ESM at the root; CJS packages (v1)
          // keep the ESM build under esm/.
          const candidates = isEsmPkg
            ? [path.join(pkgDir, `${sub}.js`)]
            : [
                path.join(pkgDir, "esm", `${sub}.js`),
                path.join(pkgDir, `${sub}.js`),
              ];
          for (const candidate of candidates) {
            if (fs.existsSync(candidate)) return candidate;
          }
          return null;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [nobleHashesBareSubpath(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "@radix-ui/react-context"],
  },
});
