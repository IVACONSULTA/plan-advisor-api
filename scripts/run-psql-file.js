#!/usr/bin/env node
/**
 * Run psql -f <file> using DATABASE_URL from the environment.
 * Loads .env from the project root (same as the API) so npm scripts work without `export`.
 */
const path = require("path");
const { spawnSync } = require("child_process");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const url = String(process.env.DATABASE_URL || "").trim();
const file = process.argv[2];

if (!file) {
  console.error("Usage: node scripts/run-psql-file.js <path-to.sql>");
  process.exit(1);
}

if (!url) {
  console.error("DATABASE_URL is not set.");
  console.error(
    "Add it to .env in the project root, for example (Docker Postgres from README):",
  );
  console.error(
    "  DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/planadvisor",
  );
  console.error("Start Postgres first, and then retry.");
  process.exit(1);
}

const r = spawnSync("psql", [url, "-f", file], {
  stdio: "inherit",
  cwd: path.join(__dirname, ".."),
});

process.exit(r.status === null ? 1 : r.status);
