import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON,
  proto,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { mkdir } from "fs/promises";
import path from "path";
import readline from "readline";
import Database from "better-sqlite3";
import fs from "fs";
import qrcode from "qrcode-terminal";
import { log } from "./logger.js";
import config from "../config.js";
import { handleMessage, registerGroupCacheEvents } from "./messageHandler.js";

function question(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

// Espera a que el socket esté listo para enviar el iq de emparejamiento.
// Sin esto, requestPairingCode se cuelga hasta defaultQueryTimeoutMs (60s).
function waitForSocketReady(sock, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (sock.ws?.readyState === 1) return resolve();

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("El socket no estuvo listo a tiempo"));
    }, timeoutMs);

    const onOpen = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error("El socket se cerró antes de emparejar")); };

    function cleanup() {
      clearTimeout(timer);
      sock.ws?.off?.("open", onOpen);
      sock.ws?.off?.("close", onClose);
    }

    sock.ws?.once?.("open", onOpen);
    sock.ws?.once?.("close", onClose);
  });
}

// El código de emparejamiento de WhatsApp usa Crockford base32
// (123456789ABCDEFGHJKLMNPQRSTVWXYZ): no admite I, L, O ni U.
// Un código fijo como "GITHUBUG" es inválido y WhatsApp rechaza el vínculo,
// dejando el await de requestPairingCode colgado.
const CROCKFORD = "123456789ABCDEFGHJKLMNPQRSTVWXYZ";

// Código de emparejamiento vigente por sesión, para que una reconexión
// no emita uno nuevo mientras el usuario lo escribe.
const activePairingCodes = new Map();

// Sesiones que ya pidieron su código: evita volver a pedirlo en cada
// reconexión (WhatsApp cierra el socket con 428 tras emitirlo, así que
// reintentar el request producía un bucle infinito de códigos).
const pairingRequested = new Map();

function isValidPairingCode(code) {
  return typeof code === "string" && code.length === 8 && [...code].every((c) => CROCKFORD.includes(c));
}

async function requestPairingCodeWithRetry(sock, phone, botLabel, existingCode, attempts = 3) {
  let lastError;
  // Reutilizamos el código ya emitido para que una reconexión no muestre
  // un código distinto mientras el usuario lo escribe en el teléfono.
  const reuse = isValidPairingCode(existingCode) ? existingCode : undefined;
  for (let i = 1; i <= attempts; i++) {
    try {
      await waitForSocketReady(sock);
      const code = await Promise.race([
        sock.requestPairingCode(phone, reuse),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout al pedir el código")), 30000)
        ),
      ]);
      if (!code) throw new Error("código vacío");
      return code;
    } catch (e) {
      lastError = e;
      log.warn(`[${botLabel}] Intento ${i}/${attempts} de emparejar falló: ${e.message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastError;
}

export async function useSQLiteAuthState(sessionDir) {
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const authDb = new Database(path.join(sessionDir, "auth.db"));
  authDb.pragma("journal_mode = WAL");
  authDb.exec(`CREATE TABLE IF NOT EXISTS auth (id TEXT PRIMARY KEY, data TEXT)`);

  const readData = (id) => {
    const row = authDb.prepare("SELECT data FROM auth WHERE id = ?").get(id);
    return row ? JSON.parse(row.data, BufferJSON.reviver) : null;
  };

  const writeData = (data, id) => {
    authDb
      .prepare("INSERT OR REPLACE INTO auth (id, data) VALUES (?, ?)")
      .run(id, JSON.stringify(data, BufferJSON.replacer));
  };

  const removeData = (id) => authDb.prepare("DELETE FROM auth WHERE id = ?").run(id);

  let creds = readData("creds") || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          ids.forEach((id) => {
            let value = readData(`${type}-${id}`);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          });
          return data;
        },
        set: async (data) => {
          for (const cat in data) {
            for (const id in data[cat]) {
              const val = data[cat][id];
              if (val) {
                writeData(val, `${cat}-${id}`);
              } else {
                removeData(`${cat}-${id}`);
              }
            }
          }
        },
      },
    },
    saveCreds: () => writeData(creds, "creds"),
  };
}

export async function clearSocketFiles(sessionDir) {
  try {
    const dbPath = path.join(sessionDir, "auth.db");
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath);
      const result = db.prepare("DELETE FROM auth WHERE id != 'creds'").run();
      if (result.changes > 0) {
        log.warn(`🗑️ Limpiados ${result.changes} registros de socket en la base de datos de [${path.basename(sessionDir)}]`);
      }
      db.close();
    }
  } catch (e) {
    log.error(`Error al limpiar base de datos de sockets: ${e.message}`);
  }
}

export async function createConnection({
  sessionDir = config.sessionDir,
  botLabel = "MAIN",
  isSubbot = false,
  phoneNumber = null,
  _attempt = 0,
} = {}) {
  await mkdir(sessionDir, { recursive: true });

  // No borrar las claves de sesión al reconectar: clearSocketFiles elimina
  // todas las entradas menos "creds", lo que rompe el vínculo cuando el
  // usuario todavía está escribiendo el código en el teléfono. Solo se
  // limpia ante una sesión corrupta (badSession), más abajo.
  if (_attempt > 0) {
    const delay = Math.min(config.reconnectDelay * _attempt, 30000);
    log.info(`[${botLabel}] Esperando ${delay / 1000}s para reconectar...`);
    await new Promise((r) => setTimeout(r, delay));
  }

  const { state, saveCreds } = await useSQLiteAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  let useCode = false;
  let phone = phoneNumber;

  if (!isSubbot && !state.creds.registered) {
    if (!phone && _attempt === 0) {
      const choice = await question(
        "\n ╔══════════════════════════════════╗\n" +
        " ║ [1] Código de emparejamiento ║\n" +
        " ║ [2] Código QR ║\n" +
        " ╚══════════════════════════════════╝\n" +
        " Elige (1 o 2): "
      );

      if (choice === "1") {
        let rawPhone = await question(
          " Digita el número de teléfono (ej: 521XXXXXXXXXX): "
        );
        rawPhone = rawPhone.replace(/\D/g, "");
        if (!rawPhone.startsWith("+")) rawPhone = `+${rawPhone}`;
        if (rawPhone.startsWith("+521")) {
          rawPhone = rawPhone.replace("+521", "+52");
        } else if (rawPhone.startsWith("+52") && rawPhone[4] === "1") {
          rawPhone = rawPhone.replace("+52 1", "+52");
        }
        phone = rawPhone.replace(/\D/g, "");
      }
    }
    // Si ya tenemos número (p. ej. tras una reconexión), seguimos en modo
    // código sin volver a preguntar.
    useCode = !!phone;
  }

  let sock;
  let connectionTimeout;
  let connected = false;
  let pendingMessages = [];

  const msgStore = new Map();
  const MAX_STORE_SIZE = 500;

  function cacheMessage(msg) {
    if (!msg?.key?.id) return;
    const cacheKey = `${msg.key.remoteJid}:${msg.key.id}`;
    msgStore.set(cacheKey, msg);
    if (msgStore.size > MAX_STORE_SIZE) {
      const oldestKey = msgStore.keys().next().value;
      msgStore.delete(oldestKey);
    }
  }

  function clearConnTimeout() {
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
      connectionTimeout = null;
    }
  }

  async function flushPending() {
    const queue = pendingMessages.splice(0);
    for (const { msg, label } of queue) {
      handleMessage(sock, msg, label).catch((e) =>
        log.error(`[${label}] Error en mensaje: ${e.message}`)
      );
    }
  }

  try {
    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
      },
      printQRInTerminal: !useCode,
      logger: pino({ level: "silent" }),
      browser: useCode ? ["Ubuntu", "Chrome", "20.0.04"] : ["YutaBot", "Chrome", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: true,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 3000,
      defaultQueryTimeoutMs: 60000,
      getMessage: async (key) => {
        const cacheKey = `${key.remoteJid}:${key.id}`;
        const cached = msgStore.get(cacheKey);
        return cached?.message || undefined;
      },
    });
  } catch (e) {
    log.error(`[${botLabel}] Error al crear socket: ${e.message}`);
    if (_attempt < config.maxReconnectAttempts) {
      return createConnection({ sessionDir, botLabel, isSubbot, phoneNumber: phone, _attempt: _attempt + 1 });
    }
    return;
  }

  sock.sessionDir = sessionDir;

  if (useCode && !state.creds.registered && !pairingRequested.has(sessionDir)) {
    try {
      const prevCode = activePairingCodes.get(sessionDir);
      const code = await requestPairingCodeWithRetry(sock, phone, botLabel, prevCode);
      pairingRequested.set(sessionDir, true);
      activePairingCodes.set(sessionDir, code);
      const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
      console.log(
        `\n ┌───────────────────────────────────┐\n` +
        ` │ 🔑 Tu código: ${String(formatted).padEnd(18)}│\n` +
        ` └───────────────────────────────────┘\n` +
        `\n Abre WhatsApp → Dispositivos vinculados →\n` +
        ` Vincular con número de teléfono e ingrésalo.\n`
      );
    } catch (e) {
      log.error(`[${botLabel}] Error al pedir código: ${e.message}`);
      log.warn(`[${botLabel}] Reintentando con QR. Reinicia el bot y elige la opción 2.`);
      try { sock.end(new Error("pairing-code-failed")); } catch {}
    }
  }

  const pairingMode = useCode && !state.creds.registered;

  // En modo emparejamiento el socket permanece cerrado hasta que el usuario
  // ingrese el código, así que el timeout corto lo mataría. Le damos margen.
  const timeoutMs = pairingMode ? 300000 : 75000;
  connectionTimeout = setTimeout(() => {
    if (!connected) {
      log.warn(`[${botLabel}] Timeout de conexión alcanzado, reconectando...`);
      try { sock.end(new Error("timeout")); } catch {}
    }
  }, timeoutMs);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr && !useCode) {
      log.info(`[${botLabel}] QR listo para escanear`);
      qrcode.generate(qr, { small: true });
    }

    if (connection === "connecting") {
      log.conn(`[${botLabel}] Conectando...`);
    }

    if (connection === "open") {
      clearConnTimeout();
      connected = true;
      activePairingCodes.delete(sessionDir);
      pairingRequested.delete(sessionDir);
      log.ok(`[${botLabel}] ✅ Conectado → ${sock.user?.id}`);
      await flushPending();
    }

    if (connection === "close") {
      clearConnTimeout();
      connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message || "Desconocido";

      log.warn(`[${botLabel}] ❌ Conexión cerrada → código: ${statusCode} | ${errorMsg}`);

      if (statusCode === DisconnectReason.loggedOut) {
        log.error(`[${botLabel}] Sesión cerrada (loggedOut). Elimina el archivo "auth.db" dentro de la carpeta "${path.basename(sessionDir)}" y reinicia.`);
        return;
      }

      if (statusCode === DisconnectReason.connectionReplaced) {
        log.error(`[${botLabel}] Sesión reemplazada por otra instancia. Cerrando.`);
        return;
      }

      if (statusCode === DisconnectReason.badSession) {
        log.error(`[${botLabel}] Sesión corrupta. Limpiando y reconectando...`);
        await clearSocketFiles(sessionDir);
      }

      // Tras emitir el código de emparejamiento WhatsApp cierra el socket
      // con 428 de forma esperada: hay que esperar a que el usuario lo
      // ingrese. Reconectamos sin reiniciar el contador de intentos para
      // no agotar maxReconnectAttempts durante la espera.
      if (pairingMode && statusCode === DisconnectReason.connectionClosed) {
        log.info(`[${botLabel}] Esperando a que ingreses el código en el teléfono...`);
        setTimeout(() => {
          createConnection({ sessionDir, botLabel, isSubbot, phoneNumber: phone, _attempt });
        }, 5000);
        return;
      }

      if (_attempt < config.maxReconnectAttempts) {
        log.info(`[${botLabel}] Reconectando (intento ${_attempt + 1}/${config.maxReconnectAttempts})...`);
        createConnection({ sessionDir, botLabel, isSubbot, phoneNumber: phone, _attempt: _attempt + 1 });
      } else {
        log.error(`[${botLabel}] Se agotaron los intentos de reconexión.`);
      }
    }
  });

  sock.ev.on("CB:stream:error", (err) => {
    log.error(`[${botLabel}] Stream error: ${err?.message || err}`);
  });

  sock.ws?.on?.("error", (err) => {
    log.error(`[${botLabel}] WS error: ${err?.message || err}`);
  });

  sock.ev.on("creds.update", saveCreds);

  registerGroupCacheEvents(sock);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key?.remoteJid === "status@broadcast") continue;

      cacheMessage(msg);

      if (!connected) {
        pendingMessages.push({ msg, label: botLabel });
        return;
      }

      handleMessage(sock, msg, botLabel).catch((e) =>
        log.error(`[${botLabel}] Error en mensaje: ${e.message}`)
      );
    }
  });

  return sock;
}