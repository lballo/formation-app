/**
 * ═══════════════════════════════════════════════════════════
 *  API : Évaluation à froid J+90 (Qualiopi — Ind. 11 & critère 7)
 *  Endpoint : /api/eval-froid
 *
 *  GET  ?token=xxx  → Contexte (participant, formation, déjà rempli ?)
 *  POST             → Enregistre les réponses + coche "Éval à froid complétée"
 *
 *  Token = ID de page Notion du participant. Zéro Make.com.
 *  BDD : ❄️ Évaluations à froid (71fdda02ad4d40b6bfa673acf7b02690)
 * ═══════════════════════════════════════════════════════════
 */

const PARTICIPANTS_DB = "2fd075e127d281108567d716b7d6b3e1";
const EVAL_FROID_DB = "71fdda02ad4d40b6bfa673acf7b02690";

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
  const note = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null; };

  async function loadContext(token) {
    const pageId = token.replace(/-/g, "");
    const participant = await getPage(pageId);
    if (!participant || participant.object === "error") return { error: "Token invalide" };
    if ((participant.parent?.database_id || "").replace(/-/g, "") !== PARTICIPANTS_DB) {
      return { error: "Token invalide" };
    }
    let formationNom = "";
    const sessionId = rel(participant, "📅 Sessions")[0];
    if (sessionId) {
      const session = await getPage(sessionId);
      formationNom = title(session, "Titre formation");
      const fId = rel(session, "Formation")[0];
      if (fId) {
        const formation = await getPage(fId);
        formationNom = title(formation, "Nom de la formation") || formationNom;
      }
    }
    return {
      participant: { id: participant.id, nom: title(participant, "Nom complet") },
      formation: formationNom,
      dejaComplete: !!participant.properties?.["Éval à froid complétée"]?.checkbox,
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
      const nCompetences = note(b.competences), nImpact = note(b.impact), nReco = note(b.recommandation);
      if (!b.miseEnPratique || !b.objectifs || !nCompetences || !nImpact || !nReco) {
        return res.status(400).json({ error: "Merci de compléter les champs obligatoires" });
      }
      const ctx = await loadContext(b.token);
      if (ctx.error) return res.status(404).json({ error: ctx.error });
      if (ctx.dejaComplete) return res.status(409).json({ error: "Évaluation déjà transmise" });

      const now = new Date().toISOString();
      const properties = {
        "Name": { title: [{ text: { content: `Éval à froid — ${ctx.participant.nom}` } }] },
        "Participant": { relation: [{ id: ctx.participant.id }] },
        "Date soumission": { date: { start: now } },
        "Complété": { checkbox: true },
        "Mise en pratique des acquis": { select: { name: b.miseEnPratique } },
        "Objectifs initiaux atteints": { select: { name: b.objectifs } },
        "Compétences durablement acquises (1-10)": { number: nCompetences },
        "Impact sur la pratique pro (1-10)": { number: nImpact },
        "Recommandation (1-10)": { number: nReco },
        "Exemples concrets d'application": { rich_text: rt(b.exemples) },
        "Freins rencontrés": { rich_text: rt(b.freins) },
        "Besoins complémentaires": { rich_text: rt(b.besoins) },
        "Réponses JSON": { rich_text: rt(JSON.stringify(b, (k, v) => k === "token" ? undefined : v)) },
      };

      const create = await fetch("https://api.notion.com/v1/pages", {
        method: "POST", headers: notionHeaders,
        body: JSON.stringify({ parent: { database_id: EVAL_FROID_DB }, properties }),
      });
      if (!create.ok) { console.error(await create.text()); return res.status(500).json({ error: "Échec de l'enregistrement" }); }

      // ✅ Coche automatique (zéro Make.com)
      await fetch(`https://api.notion.com/v1/pages/${ctx.participant.id}`, {
        method: "PATCH", headers: notionHeaders,
        body: JSON.stringify({ properties: { "Éval à froid complétée": { checkbox: true } } }),
      });

      return res.status(200).json({ ok: true });
    } catch (e) { console.error(e); return res.status(500).json({ error: "Erreur serveur" }); }
  }

  return res.status(405).json({ error: "Méthode non autorisée" });
}
