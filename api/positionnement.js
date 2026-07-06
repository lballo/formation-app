/**
 * ═══════════════════════════════════════════════════════════
 *  API : Questionnaire de positionnement (Qualiopi — Ind. 4 & 8)
 *  Endpoint : /api/positionnement
 *
 *  GET  ?token=xxx  → Contexte (participant, session, formation, déjà rempli ?)
 *  POST             → Enregistre les réponses + coche "Positionnement complété"
 *
 *  Token = ID de page Notion du participant (pattern satisfaction).
 *  Zéro Make.com : la case est cochée directement par l'API.
 * ═══════════════════════════════════════════════════════════
 */

const PARTICIPANTS_DB = "2fd075e127d281108567d716b7d6b3e1";
const POSITIONNEMENT_DB = "2fd075e127d281f2812efef8efcd5f21";

export default async function handler(req, res) {
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

  const getPage = async (id) => {
    const r = await fetch(`https://api.notion.com/v1/pages/${id}`, { headers: notionHeaders });
    return r.ok ? r.json() : null;
  };
  const title = (p, n) => p?.properties?.[n]?.title?.[0]?.plain_text || "";
  const rel = (p, n) => (p?.properties?.[n]?.relation || []).map(r => r.id);
  const rt = (s) => s ? [{ text: { content: String(s).slice(0, 1900) } }] : [];

  async function loadContext(token) {
    const pageId = token.replace(/-/g, "");
    const participant = await getPage(pageId);
    if (!participant || participant.object === "error") return { error: "Token invalide" };
    if ((participant.parent?.database_id || "").replace(/-/g, "") !== PARTICIPANTS_DB) {
      return { error: "Token invalide" };
    }
    let sessionTitre = "", formationNom = "";
    const sessionId = rel(participant, "📅 Sessions")[0];
    if (sessionId) {
      const session = await getPage(sessionId);
      sessionTitre = title(session, "Titre formation");
      const fId = rel(session, "Formation")[0];
      if (fId) {
        const formation = await getPage(fId);
        formationNom = title(formation, "Nom de la formation");
      }
    }
    return {
      participant: { id: participant.id, nom: title(participant, "Nom complet") },
      session: sessionTitre,
      formation: formationNom || sessionTitre,
      dejaComplete: !!participant.properties?.["Positionnement complété"]?.checkbox,
    };
  }

  // ═══════════════ GET ═══════════════
  if (req.method === "GET") {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: "Token manquant" });
    try {
      const ctx = await loadContext(token);
      if (ctx.error) return res.status(404).json({ error: ctx.error });
      return res.status(200).json(ctx);
    } catch (e) { console.error(e); return res.status(500).json({ error: "Erreur serveur" }); }
  }

  // ═══════════════ POST ═══════════════
  if (req.method === "POST") {
    try {
      const b = req.body || {};
      if (!b.token) return res.status(400).json({ error: "Token manquant" });
      if (!b.motivation || !b.competences || !b.niveauExperience) {
        return res.status(400).json({ error: "Merci de compléter les champs obligatoires" });
      }
      const ctx = await loadContext(b.token);
      if (ctx.error) return res.status(404).json({ error: ctx.error });
      if (ctx.dejaComplete) return res.status(409).json({ error: "Questionnaire déjà transmis" });

      const now = new Date().toISOString();
      const properties = {
        "Name": { title: [{ text: { content: `Positionnement — ${ctx.participant.nom}` } }] },
        "Participant": { relation: [{ id: ctx.participant.id }] },
        "Date soumission": { date: { start: now } },
        "Complété": { checkbox: true },
        "Quelle est votre motivation?": { rich_text: rt(b.motivation) },
        "Quelle est votre besoin?": { rich_text: rt(b.besoin) },
        "Quelles compétences souhaitez-vous acquérir?": { rich_text: rt(b.competences) },
        "Besoin d'aménagement (handicap)": { rich_text: rt(b.handicap) },
        "Réponses JSON": { rich_text: rt(JSON.stringify({ attentes: b.attentes || "", contexte: b.contexte || "" })) },
      };
      if (b.niveauExperience) properties["Niveau expérience"] = { select: { name: b.niveauExperience } };
      if (b.formationsSimilaires) {
        properties["Avez-vous déjà suivi des formations similaires?"] = {
          multi_select: [{ name: b.formationsSimilaires === "oui" ? "oui" : "non jamais" }],
        };
      }

      const create = await fetch("https://api.notion.com/v1/pages", {
        method: "POST", headers: notionHeaders,
        body: JSON.stringify({ parent: { database_id: POSITIONNEMENT_DB }, properties }),
      });
      if (!create.ok) { console.error(await create.text()); return res.status(500).json({ error: "Échec de l'enregistrement" }); }

      // ✅ Coche automatique (zéro Make.com)
      await fetch(`https://api.notion.com/v1/pages/${ctx.participant.id}`, {
        method: "PATCH", headers: notionHeaders,
        body: JSON.stringify({ properties: { "Positionnement complété": { checkbox: true } } }),
      });

      return res.status(200).json({ ok: true });
    } catch (e) { console.error(e); return res.status(500).json({ error: "Erreur serveur" }); }
  }

  return res.status(405).json({ error: "Méthode non autorisée" });
}
