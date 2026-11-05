import { ensureDeps } from "./scripts/ensure-deps.js";

ensureDeps();

await import("./app.js");
