import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORK_NAME = "yuta-baileys";
const BAILEYS_PKG = path.join(root, "node_modules", "@whiskeysockets", "baileys", "package.json");

function installedBaileys() {
  if (!existsSync(BAILEYS_PKG)) return null;
  try {
    const pkg = JSON.parse(readFileSync(BAILEYS_PKG, "utf8"));
    return { name: pkg.name, version: pkg.version };
  } catch {
    return null;
  }
}

function runNpm(args) {
  return spawnSync("npm", args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

function runNpmInstall() {
  console.log("\n\x1b[33m[setup]\x1b[0m Faltan dependencias. Instalando desde la librería...\n");
  const flags = ["--no-audit", "--no-fund"];
  const hasLock = existsSync(path.join(root, "package-lock.json"));

  let res = hasLock ? runNpm(["ci", ...flags]) : runNpm(["install", ...flags]);

  if (hasLock && (res.error || res.status !== 0)) {
    console.log("\x1b[33m[setup]\x1b[0m npm ci falló (lock desincronizado). Reintentando con npm install...");
    res = runNpm(["install", ...flags]);
  }

  if (res.error) throw res.error;
  if (res.status !== 0) {
    console.error("\x1b[31m[setup]\x1b[0m npm falló. Revisa tu conexión o Node.js (v20+).");
    process.exit(1);
  }
}

export function ensureDeps() {
  if (!existsSync(path.join(root, "node_modules"))) {
    runNpmInstall();
    return;
  }

  const baileys = installedBaileys();
  if (!baileys) {
    runNpmInstall();
    return;
  }

  if (baileys.name !== FORK_NAME) {
    console.log(
      `\x1b[33m[setup]\x1b[0m Baileys instalado es "${baileys.name}", se esperaba "${FORK_NAME}". Reinstalando...`
    );
    runNpmInstall();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureDeps();
  console.log("\x1b[32m[setup]\x1b[0m Dependencias listas.");
}
