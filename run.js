#!/usr/bin/env node
// Starts the local server and opens the app in your default browser.
const { spawn, exec } = require("child_process");
const path = require("path");

const PORT = 8123;

console.log("\n  AITAH Video Creator (Web Edition)\n");

const server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
  stdio: "inherit",
});

setTimeout(() => {
  const url = `http://localhost:${PORT}`;
  const opener = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  exec(`${opener} ${url}`);
}, 1500);

console.log(`  Running at http://localhost:${PORT}`);
console.log("  Press Ctrl+C to stop\n");

process.on("SIGINT", () => {
  console.log("\n  Shutting down...");
  server.kill("SIGINT");
  process.exit(0);
});

server.on("exit", (code) => process.exit(code || 0));
