import { db } from "../../database/db.js";
import { PERSONAJES } from "../../core/gamedata.js";

function getPersonajes(jid) {
  const user = db.getUser(jid);
  return user.personajes || {};
}

export default {
  name: ["buychar", "اشتري_شخصية"],
  description: "Compra un personaje de Jujutsu Kaisen",
  category: "economy",

  async run({ sender, args, reply, react }) {
    const personajeId = args[0]?.toLowerCase();

    if (!personajeId) {
      await react("⚔️");

      const nuevos = Object.entries(PERSONAJES).filter(([, p]) => p.generacion === "new_gen");
      const viejos = Object.entries(PERSONAJES).filter(([, p]) => p.generacion === "old_gen");
      const mios = getPersonajes(sender);

      let texto = `⚔️ *Personajes de Jujutsu Kaisen*\n╰━━━━━━(☆)━━━━━━─╮\n\n`;

      texto += `*── New Gen ──*\n\n`;
      for (const [id, p] of nuevos) {
        const tenido = mios[id] ? " ✅" : "";
        texto += `*${p.nombre}*${tenido}\n`;
        texto += `   💰 ${p.precio.toLocaleString()} Fragmentos\n`;
        texto += `   🆔 \`${id}\`\n\n`;
      }

      texto += `*── Old Gen ──*\n\n`;
      for (const [id, p] of viejos) {
        const tenido = mios[id] ? " ✅" : "";
        texto += `*${p.nombre}*${tenido}\n`;
        texto += `   💰 ${p.precio.toLocaleString()} Fragmentos\n`;
        texto += `   🆔 \`${id}\`\n\n`;
      }

      texto += `> Usá *.buychar <ID>* para comprar\n> Usá *.equipar <item> <personaje>* para darle equipo`;

      return await reply({ text: texto });
    }

    const personaje = PERSONAJES[personajeId];
    if (!personaje) {
      return await reply({ text: "❌ Personaje no encontrado.\n\n> Usá *.buychar* para ver la lista" });
    }

    const misPersonajes = getPersonajes(sender);
    if (misPersonajes[personajeId]) {
      return await reply({ text: `❌ Ya tenés a *${personaje.nombre}*.` });
    }

    const eco = db.getEco(sender);
    if (eco.bolsillo < personaje.precio) {
      const faltante = personaje.precio - eco.bolsillo;
      return await reply({
        text:
          `❌ No tenés suficientes Fragmentos.\n\n` +
          `*Precio:* ${personaje.precio.toLocaleString()} Fragmentos\n` +
          `*Bolsillo:* ${eco.bolsillo.toLocaleString()} Fragmentos\n` +
          `*Te faltan:* ${faltante.toLocaleString()} Fragmentos`
      });
    }

    misPersonajes[personajeId] = { nivel: 1, xp: 0, arma: null, armadura: null };
    db.setEco(sender, { bolsillo: eco.bolsillo - personaje.precio });
    db.setUser(sender, { personajes: misPersonajes });

    await react("✅");
    return await reply({
      text:
        `✅ *¡Compraste a ${personaje.nombre}!*\n\n` +
        `*Precio pagado:* ${personaje.precio.toLocaleString()} Fragmentos\n` +
        `*Bolsillo restante:* ${(eco.bolsillo - personaje.precio).toLocaleString()} Fragmentos\n\n` +
        `> Usá *.equipar <item> ${personajeId}* para darle equipo`
    });
  }
};