/**
 * ═══════════════════════════════════════════════════════════
 *  API : Espace stagiaire (portail unifié)
 *  Endpoint : /api/espace?token=xxx  (GET uniquement)
 *
 *  Un lien = un stagiaire = tout son parcours :
 *  - Statuts : positionnement, émargements x/y, évaluation fin,
 *    satisfaction à chaud, évaluation à froid
 *  - Session : dates, horaires, lieu
 *  - Ressources : Programme PDF + Support participant (formation)
 *    et Supports personnalisés (session)
 *
 *  Note : les URLs de fichiers Notion expirent après ~1h ;
 *  elles sont régénérées à chaque chargement de la page.
 * ═══════════════════════════════════════════════════════════
 */

const PARTICIPANTS_DB = "2fd075e127d281108567d716b7d6b3e1";
const EMARGEMENTS_DB = "2fd075e127d281a48683e5c9f16c411b";

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowed = ["https://formation.lauraballo.com", "https://lauraballo.com", "https://www.lauraballo.com"];
  res.setHeader("Access-Control-Allow-Origin", allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Méthode non autorisée" });

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
  const text = (p, n) => (p?.properties?.[n]?.rich_text || []).map(t => t.plain_text).join("");
  const num = (p, n) => p?.properties?.[n]?.number ?? null;
  const date = (p, n) => p?.properties?.[n]?.date?.start || null;
  const sel = (p, n) => p?.properties?.[n]?.select?.name || "";
  const check = (p, n) => !!p?.properties?.[n]?.checkbox;
  const rel = (p, n) => (p?.properties?.[n]?.relation || []).map(r => r.id);
  const urlProp = (p, n) => p?.properties?.[n]?.url || null;
  const files = (p, n, source) => (p?.properties?.[n]?.files || [])
    .map(f => ({ nom: f.name, url: f.file?.url || f.external?.url || null, source }))
    .filter(f => f.url);

  const token = req.query.token;
  if (!token) return res.status(400).json({ error: "Token manquant" });

  try {
    const pageId = token.replace(/-/g, "");
    const participant = await getPage(pageId);
    if (!participant || participant.object === "error") return res.status(404).json({ error: "Token invalide" });
    if ((participant.parent?.database_id || "").replace(/-/g, "") !== PARTICIPANTS_DB) {
      return res.status(404).json({ error: "Token invalide" });
    }

    // Session + formation
    let session = null, formation = null;
    const sessionId = rel(participant, "📅 Sessions")[0];
    if (sessionId) {
      session = await getPage(sessionId);
      const fId = session ? rel(session, "Formation")[0] : null;
      if (fId) formation = await getPage(fId);
    }
    const jours = Math.min((session && num(session, "Durée (jours)")) || (formation && num(formation, "Durée (jours)")) || 1, 5);

    // Émargements signés
    let signes = 0;
    const q = await fetch(`https://api.notion.com/v1/databases/${EMARGEMENTS_DB}/query`, {
      method: "POST", headers: notionHeaders,
      body: JSON.stringify({
        filter: { and: [
          { property: "Participant", relation: { contains: participant.id } },
          { property: "Signé", checkbox: { equals: true } },
        ]},
        page_size: 100,
      }),
    });
    if (q.ok) signes = (await q.json()).results.length;

    // Ressources (URLs Notion valides ~1h, régénérées à chaque appel)
    const ressources = [
      ...(formation ? files(formation, "Programme PDF", "Programme") : []),
      ...(formation ? files(formation, "Support participant", "Support de formation") : []),
      ...(session ? files(session, "Supports personnalisés", "Support de votre session") : []),
    ];

    return res.status(200).json({
      participant: {
        nom: title(participant, "Nom complet"),
        prenom: text(participant, "Prénom"),
      },
      session: session ? {
        titre: title(session, "Titre formation"),
        code: text(session, "Code session"),
        dateDebut: date(session, "Date début"),
        dateFin: date(session, "Date fin"),
        horaires: text(session, "Horaires"),
        lieu: text(session, "Lieu"),
        type: sel(session, "Type"),
        jours,
      } : null,
      formation: formation ? {
        nom: title(formation, "Nom de la formation"),
        formEvaluation: urlProp(formation, "Form Évaluation"),
      } : null,
      statuts: {
        positionnement: check(participant, "Positionnement complété"),
        evaluation: check(participant, "Évaluation complétée"),
        satisfaction: check(participant, "Satisfaction complétée"),
        evalFroid: check(participant, "Éval à froid complétée"),
        emargements: { signes, attendus: jours * 2 },
      },
      ressources,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}
