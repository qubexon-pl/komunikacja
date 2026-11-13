// Starts the Node server (pages and most of the API, port from .env, usually 3000) and the FastAPI server
// (trip sharing, accounts for the mobile app, port 8000) together. Open the app at the Node address as before;
// Node passes /api/trips/* on to FastAPI. Ctrl+C stops both.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = process.platform === "win32"
  ? path.join(root, "api", ".venv", "Scripts", "python.exe")
  : path.join(root, "api", ".venv", "bin", "python");

if (!existsSync(python)) {
  console.error("Brak środowiska Pythona dla FastAPI. Utwórz je raz:\n  cd api && python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt");
  process.exit(1);
}

const children = [];
function run(name, command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const prefix = (line) => `[${name}] ${line}`;
  for (const stream of [child.stdout, child.stderr]) {
    let rest = "";
    stream.on("data", (chunk) => {
      const lines = (rest + chunk.toString()).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) console.log(prefix(line));
    });
  }
  child.on("exit", (code) => {
    console.log(prefix(`zakończony (kod ${code})`));
    stopAll();
  });
  children.push(child);
}

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

run("node", process.execPath, ["src/server.js"], root);
run("api", python, ["-m", "uvicorn", "app.main:app", "--port", "8000"], path.join(root, "api"));
