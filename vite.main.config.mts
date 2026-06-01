import { defineConfig } from "vite";
import path from "path";

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      external: [
        "better-sqlite3",
        // ESM-only packages that need to be externalized
        "helia",
        "@helia/json",
        "@helia/unixfs",
        "blockstore-fs",
        "datastore-fs",
        "multiformats",
        "@libp2p/crypto",
        // Holepunch (hypercore) stack — native addons + ESM
        "hypercore",
        "hyperbee",
        "hyperdrive",
        "hyperswarm",
        "corestore",
        "autobase",
        "b4a",
        "compact-encoding",
        "sodium-native",
        "udx-native",
        "random-access-file",
        "random-access-storage",
        "hypercore-crypto",
        "protomux",
        "streamx",
        // WebSocket optional native modules (ws package)
        "bufferutil",
        "utf-8-validate",
        // Heavy Node.js packages — externalize to avoid heap OOM during bundling
        "googleapis",
        "google-auth-library",
        "playwright-core",
        "ethers",
        "imapflow",
        "nodemailer",
        "mailparser",
        "@microsoft/microsoft-graph-client",
        "@azure/identity",
        "node-ical",
        // Babel/recast — bundling breaks Object.defineProperty in Flow/class init
        "@babel/parser",
        "@babel/traverse",
        "@babel/types",
        "@babel/generator",
        "recast",
        // dugite — must be external so __dirname resolves to its real location
        // for embedded git binary discovery
        "dugite",
        // discord.js — heavy native deps, externalize
        "discord.js",
        // Claude Code SDK — uses package.json exports map that Vite/Rollup
        // can't resolve at build time; lazy-loaded by copilot/claude_runner.ts
        "@anthropic-ai/claude-code",
        // Fleek SDK — broken `exports` field on transitive `files-from-path`;
        // lazy-loaded by decentralized_deploy_handlers.ts
        "@fleek-platform/sdk",
        "@fleek-platform/sdk/node",
        "files-from-path",
        // Lit Protocol — optional TEE attestation; loaded lazily in
        // attestation_provider.ts only when JOY_LIT_NETWORK is configured.
        // Package is intentionally not installed by default.
        "@lit-protocol/lit-node-client",
      ],
    },
  },
  plugins: [],
});
