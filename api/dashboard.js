/**
 * ═══════════════════════════════════════════════════════════
 *  API : Dashboard formateur — V3 (jauges & grands boutons)
 *  Endpoint : /api/dashboard?key=XXXX
 *
 *  Remonte pour chaque participant :
 *  - les statuts des 5 étapes (checkboxes)
 *  - le compte d'émargements signés
 *  - les IDs Notion des fiches de réponses complétées
 *    (positionnement, évaluation, satisfaction, éval à froid)
 *    → le dashboard ouvre la fiche quand l'étape est faite
 *  - le score d'évaluation de fin (Score écrit)
 *
 *  Sécurité : variable d'environnement DASHBOARD_SECRET.
 * ═══════════════════════════════════════════════════════════
 */

const SESSIONS_DB = "2fd075e127d281d5a34bdeacdc88c160";
const EMARGEMENTS_DB = "2fd075e127d281a48683e5c9f16c411b";
const EVAL_FROID_DB = "71fdda02ad4d40b6bfa673acf7b02690";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Méthode non autorisée" });

  const SECRET = process.env.DASHBOARD_SECRET;
  if (!SECRET || req.query.key !== SECRET) {
    return res.status(401).json({ error: "Accès refusé" });
  }
  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  if (!NOTION_API_KEY) return res.status(500).json({ error: "Clé API manquante" });

  const notionHeaders = {
    "Authorization": `Bearer ${NOTION_API_KEY}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };

  const title = (p, n) => p?.properties?.[n]?.title?.[0]?.plain_text || "";
  const text = (p, n) => (p?.properties?.[n]?.rich_text || []).map(t => t.plain_text).join("");
  const num = (p, n) => p?.properties?.[n]?.number ?? null;
  const date = (p, n) => p?.properties?.[n]?.date?.start || null;
  const sel = (p, n) => p?.properties?.[n]?.select?.name || "";
  const check = (p, n) => !!p?.properties?.[n]?.checkbox;
  const rel = (p, n) => (p?.properties?.[n]?.relation || []).map(r => r.id);

  const getPage = async (id) => {
    const r = await fetch(`https://api.notion.com/v1/pages/${id}`, { headers: notionHeaders });
    return r.ok ? r.json() : null;
  };

  const queryAll = async (dbId, body = {}) => {
    let results = [], cursor;
    do {
      const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: "POST", headers: notionHeaders,
        body: JSON.stringify({ ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
      });
      if (!r.ok) break;
      const data = await r.json();
      results = results.concat(data.results);
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return results;
  };

  const fetchPages = async (ids) => {
    const out = {};
    for (let i = 0; i < ids.length; i += 8) {
      const batch = ids.slice(i, i + 8);
      const pages = await Promise.all(batch.map(getPage));
      pages.forEach((p, j) => { if (p) out[batch[j]] = p; });
    }
    return out;
  };

  try {
    // 1. Sessions triées par date de début
    const sessions = await queryAll(SESSIONS_DB, {
      sorts: [{ property: "Date début", direction: "ascending" }],
    });

    // 2. Participants + Formations référencés
    const participantIds = [...new Set(sessions.flatMap(s => rel(s, "Participants")))];
    const formationIds = [...new Set(sessions.flatMap(s => rel(s, "Formation")))];
    const [participants, formations] = await Promise.all([
      fetchPages(participantIds), fetchPages(formationIds),
    ]);

    // 3. Émargements signés → compte par participant
    const emargements = await queryAll(EMARGEMENTS_DB, {
      filter: { property: "Signé", checkbox: { equals: true } },
    });
    const signCount = {};
    for (const e of emargements) {
      for (const pid of rel(e, "Participant")) signCount[pid] = (signCount[pid] || 0) + 1;
    }

    // 4. Éval à froid complétées → id de fiche par participant
    const froids = await queryAll(EVAL_FROID_DB, {
      filter: { property: "Complété", checkbox: { equals: true } },
    });
    const froidId = {};
    for (const f of froids) {
      for (const pid of rel(f, "Participant")) froidId[pid] = f.id;
    }

    // 5. Fiches d'évaluation complétées → score
    const evalIds = [...new Set(participantIds.flatMap(pid => {
      const p = participants[pid];
      return p ? rel(p, "📊 Évaluation") : [];
    }))];
    const evalPages = await fetchPages(evalIds);

    // 6. Assemblage
    const payload = sessions.map(s => {
      const fId = rel(s, "Formation")[0];
      const f = fId ? formations[fId] : null;
      const jours = num(s, "Durée (jours)") || (f ? num(f, "Durée (jours)") : 1) || 1;
      const nbAttendus = Math.min(jours, 5) * 2;
      return {
        id: s.id,
        notionUrl: s.url,
        titre: title(s, "Titre formation"),
        code: text(s, "Code session"),
        dateDebut: date(s, "Date début"),
        dateFin: date(s, "Date fin"),
        jours, nbAttendus,
        horaires: text(s, "Horaires"),
        lieu: text(s, "Lieu"),
        type: sel(s, "Type"),
        statut: sel(s, "Statut"),
        formation: f ? {
          nom: title(f, "Nom de la formation"),
          code: text(f, "Code formation"),
          notionUrl: f.url,
        } : null,
        participants: rel(s, "Participants").map(pid => {
          const p = participants[pid];
          if (!p) return null;
          const evalRecId = rel(p, "📊 Évaluation")[0] || null;
          const evalRec = evalRecId ? evalPages[evalRecId] : null;
          const scoreEcrit = evalRec ? num(evalRec, "Score écrit (70%)") : null;
          return {
            id: pid.replace(/-/g, ""),
            nom: title(p, "Nom complet"),
            email: p.properties?.["Email"]?.email || "",
            positionnement: check(p, "Positionnement complété"),
            evaluation: check(p, "Évaluation complétée"),
            satisfaction: check(p, "Satisfaction complétée"),
            evalFroid: check(p, "Éval à froid complétée"),
            emargementsSignes: signCount[pid] || 0,
            // IDs des fiches complétées (pour ouvrir la réponse dans Notion)
            posRecId: (rel(p, "📋 Positionnement")[0] || "").replace(/-/g, "") || null,
            evalRecId: (evalRecId || "").replace(/-/g, "") || null,
            satRecId: (rel(p, "😊 Satisfaction")[0] || "").replace(/-/g, "") || null,
            froidRecId: (froidId[pid] || "").replace(/-/g, "") || null,
            scoreEcrit,
          };
        }).filter(Boolean),
      };
    });

    return res.status(200).json({ generatedAt: new Date().toISOString(), sessions: payload });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}
