/**
 * ═══════════════════════════════════════════════════════════
 *  API : Émargement numérique (Qualiopi — Ind. 9, assiduité)
 *  Endpoint : /api/emargement
 *
 *  GET  ?token=xxx  → Infos session + état des créneaux du stagiaire
 *  POST             → Enregistre une signature pour un créneau
 *
 *  Le token est l'ID de page Notion du participant (même pattern
 *  que /api/satisfaction-formation). Un lien = un stagiaire.
 *  Le lien est réutilisable : les créneaux déjà signés sont
 *  affichés comme validés, les suivants restent signables.
 *
 *  BDD Notion :
 *  - 👥 Participants  (2fd075e127d281108567d716b7d6b3e1)
 *  - 📅 Sessions      (relation depuis Participants)
 *  - ✍️ Émargements   (2fd075e127d281a48683e5c9f16c411b)
 * ═══════════════════════════════════════════════════════════
 */

const PARTICIPANTS_DB = "2fd075e127d281108567d716b7d6b3e1";
const EMARGEMENTS_DB = "2fd075e127d281a48683e5c9f16c411b";

export default async function handler(req, res) {
  // ── CORS ──
  const origin = req.headers.origin || "";
  const allowed = ["https://formation.lauraballo.com", "https://lauraballo.com", "https://www.lauraballo.com"];
  res.setHeader("Access-Control-Allow-Origin", allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  if (!NOTION_API_KEY) return res.status(500).json({ error: "Clé API manquante" });

  const notionHeaders = {
    "Authorization": `Bearer ${NOTION_API_KEY}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };

  // ── Helpers ──
  const getPage = async (id) => {
    const r = await fetch(`https://api.notion.com/v1/pages/${id}`, { headers: notionHeaders });
    return r.ok ? r.json() : null;
  };

  const queryDB = async (dbId, body) => {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST", headers: notionHeaders, body: JSON.stringify(body),
    });
    return r.ok ? r.json() : { results: [] };
  };

  const title = (p, name) => p?.properties?.[name]?.title?.[0]?.plain_text || "";
  const text = (p, name) => (p?.properties?.[name]?.rich_text || []).map(t => t.plain_text).join("");
  const num = (p, name) => p?.properties?.[name]?.number ?? null;
  const date = (p, name) => p?.properties?.[name]?.date?.start || null;
  const sel = (p, name) => p?.properties?.[name]?.select?.name || "";
  const rel = (p, name) => (p?.properties?.[name]?.relation || []).map(r => r.id);

  // Découpe une longue chaîne (signature base64) en blocs rich_text ≤ 1900 chars
  const chunkRichText = (s) => {
    const out = [];
    for (let i = 0; i < s.length && out.length < 90; i += 1900) {
      out.push({ text: { content: s.slice(i, i + 1900) } });
    }
    return out;
  };

  // Jours ouvrés consécutifs à partir de la date de début (week-ends sautés)
  const sessionDays = (startISO, nbJours) => {
    const days = [];
    const d = new Date(startISO + "T12:00:00Z");
    while (days.length < nbJours) {
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) days.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return days;
  };

  // Charge participant + session + état des émargements
  async function loadContext(token) {
    const pageId = token.replace(/-/g, "");
    const participant = await getPage(pageId);
    if (!participant || participant.object === "error") return { error: "Token invalide" };
    if ((participant.parent?.database_id || "").replace(/-/g, "") !== PARTICIPANTS_DB) {
      return { error: "Token invalide" };
    }

    const sessionIds = rel(participant, "📅 Sessions");
    if (!sessionIds.length) return { error: "Aucune session associée à ce participant" };
    const session = await getPage(sessionIds[0]);
    if (!session) return { error: "Session introuvable" };

    const dateDebut = date(session, "Date début");
    const nbJours = Math.min(num(session, "Durée (jours)") || 1, 5);
    if (!dateDebut) return { error: "La session n'a pas de date de début" };

    const days = sessionDays(dateDebut, nbJours);

    // Émargements existants de CE participant sur CETTE session
    const existing = await queryDB(EMARGEMENTS_DB, {
      filter: { property: "Participant", relation: { contains: participant.id } },
      page_size: 100,
    });
    const signedMap = {};
    for (const row of existing.results) {
      const c = sel(row, "Créneau");
      if (c && row.properties?.["Signé"]?.checkbox) {
        signedMap[c] = row.properties?.["Horodatage signature"]?.date?.start || row.created_time;
      }
    }

    const creneaux = [];
    days.forEach((day, i) => {
      ["Matin", "Après-midi"].forEach((periode, j) => {
        const code = `J${i + 1} - ${periode}`;
        creneaux.push({
          code, periode, jour: i + 1, date: day,
          numero: i * 2 + j + 1,
          signe: !!signedMap[code],
          horodatage: signedMap[code] || null,
        });
      });
    });

    return {
      participant: {
        id: participant.id,
        nom: title(participant, "Nom complet"),
        prenom: text(participant, "Prénom"),
      },
      session: {
        id: session.id,
        titre: title(session, "Titre formation"),
        code: text(session, "Code session"),
        dateDebut, nbJours,
        horaires: text(session, "Horaires"),
        lieu: text(session, "Lieu"),
        type: sel(session, "Type"),
      },
      creneaux,
    };
  }

  // ═══════════════ GET : état des créneaux ═══════════════
  if (req.method === "GET") {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: "Token manquant" });
    try {
      const ctx = await loadContext(token);
      if (ctx.error) return res.status(404).json({ error: ctx.error });
      return res.status(200).json(ctx);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }

  // ═══════════════ POST : signer un créneau ═══════════════
  if (req.method === "POST") {
    try {
      const { token, creneau, signature } = req.body || {};
      if (!token || !creneau || !signature) {
        return res.status(400).json({ error: "Champs manquants (token, creneau, signature)" });
      }
      if (!/^data:image\/(png|jpeg);base64,/.test(signature) || signature.length > 160000) {
        return res.status(400).json({ error: "Signature invalide" });
      }

      const ctx = await loadContext(token);
      if (ctx.error) return res.status(404).json({ error: ctx.error });

      const slot = ctx.creneaux.find(c => c.code === creneau);
      if (!slot) return res.status(400).json({ error: "Créneau inconnu pour cette session" });
      if (slot.signe) return res.status(409).json({ error: "Ce créneau est déjà signé" });

      const now = new Date().toISOString();
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "n/a";
      const ua = (req.headers["user-agent"] || "n/a").slice(0, 1900);

      const create = await fetch("https://api.notion.com/v1/pages", {
        method: "POST", headers: notionHeaders,
        body: JSON.stringify({
          parent: { database_id: EMARGEMENTS_DB },
          properties: {
            "Identifiant": { title: [{ text: { content: `${ctx.participant.nom} — ${ctx.session.code || ctx.session.titre} — ${creneau}` } }] },
            "Participant": { relation: [{ id: ctx.participant.id }] },
            "Session": { relation: [{ id: ctx.session.id }] },
            "Créneau": { select: { name: creneau } },
            "Numéro créneau": { number: slot.numero },
            "Demi-journée": { select: { name: slot.periode } },
            "Date": { date: { start: slot.date } },
            "Horodatage signature": { date: { start: now } },
            "Signé": { checkbox: true },
            "Signature (base64)": { rich_text: chunkRichText(signature) },
            "Adresse IP": { rich_text: [{ text: { content: ip } }] },
            "User Agent": { rich_text: [{ text: { content: ua } }] },
          },
        }),
      });
      if (!create.ok) {
        console.error(await create.text());
        return res.status(500).json({ error: "Échec de l'enregistrement" });
      }

      // Tous les créneaux signés → coche "Émargements complets" (Ind. 9)
      const total = ctx.creneaux.length;
      const signedCount = ctx.creneaux.filter(c => c.signe).length + 1;
      if (signedCount >= total) {
        await fetch(`https://api.notion.com/v1/pages/${ctx.participant.id}`, {
          method: "PATCH", headers: notionHeaders,
          body: JSON.stringify({ properties: { "Émargements complets": { checkbox: true } } }),
        });
      }

      return res.status(200).json({ ok: true, creneau, horodatage: now, signedCount, total });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }

  return res.status(405).json({ error: "Méthode non autorisée" });
}
