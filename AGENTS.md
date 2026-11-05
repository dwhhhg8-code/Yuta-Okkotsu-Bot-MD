# AGENTS.md

Notas para agentes que trabajen en este repositorio.

## Estructura

- `index.js` — bootstrap. Verifica e instala dependencias (`scripts/ensure-deps.js`) y luego carga `app.js`.
- `app.js` — arranque real del bot (banner, plugins, conexión, subbots).
- `core/connection.js` — conexión WhatsApp (pairing code / QR, validación de número).
- `core/pluginLoader.js`, `core/subbotManager.js`, `core/messageHandler.js`.
- `plugins/` — comandos.
- `scripts/ensure-deps.js` — autoinstalación al arrancar.

## Librería de WhatsApp

- `@whiskeysockets/baileys` apunta al fork propio: `github:dwhhhg8-code/Yuta-Baileys`.
- El fork es un repositorio independiente (no un fork de GitHub) basado en
  `WhiskeySockets/Baileys` `v7.0.0-rc14`, con `lib/` ya compilado y sin script
  `prepare` para que no recompile al instalar.
- El nombre del paquete dentro del fork es `yuta-baileys`. `ensure-deps.js` usa
  ese nombre para detectar si se instaló la librería equivocada.
- Si se cambia la dependencia en `package.json`, hay que regenerar
  `package-lock.json` (`npm install --package-lock-only`) y mantener `resolved`
  en `git+https` (nunca `git+ssh`).

## Comandos

- `npm start` — arranca el bot (instala dependencias si faltan).
- `npm run setup` — fuerza la verificación/instalación de dependencias.
- `node index.js` — equivalente a `npm start`.

## Convenciones

- El código y los mensajes de commit están en español.
- Node.js v20+ (probado en v24).
