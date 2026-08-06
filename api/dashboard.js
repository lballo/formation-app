/**
 * ═══════════════════════════════════════════════════════════
 *  API : Dashboard formateur — V4
 *  Endpoint : /api/dashboard?key=XXXX
 *
 *  Nouveautés V4 :
 *  - Modalité (Présentiel/Distanciel/Hybride), adresse, lien visio
 *  - Entreprise cliente, convocation envoyée
 *  - Ressources fichiers (programme, support, convention, supports perso)
 *  - Rapport de session (contenu + statut)
 *  - Éval à froid retirée du flux session (reste dans l'espace stagiaire)
 * ═══════════════════════════════════════════════════════════
 */

const SESSIONS_DB = "2fd075e127d281d5a34bdeacdc88c160";
const EMARGEMENTS_DB = "2fd075e127d281a48683e5c9f16c411b";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Méthode non autorisée" });

  const SECRET = process.env.DASHBOARD_SECRET;
  if (!SECRET || req.query.key !== SECRET) return res.status(401).json({ error: "Accès refusé" });
  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  if (!NOTION_API_KEY) return res.status(500).json({ error: "Clé API manquante" });

  const notionHeaders = {
    "Authorization": `Bearer ${NOTION_API_KEY}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };

  const title = (p, n) => p?.properties?.[n]?.title?.[0]?.plain_text || "";
  const anyTitle = (p) => { for (const k in (p?.properties || {})) if (p.properties[k].type === "title") return p.properties[k].title?.[0]?.plain_text || ""; return ""; };
  const text = (p, n) => (p?.properties?.[n]?.rich_text || []).map(t => t.plain_text).join("");
  const num = (p, n) => p?.properties?.[n]?.number ?? null;
  const date = (p, n) => p?.properties?.[n]?.date?.start || null;
  const sel = (p, n) => p?.properties?.[n]?.select?.name || "";
  const check = (p, n) => !!p?.properties?.[n]?.checkbox;
  const rel = (p, n) => (p?.properties?.[n]?.relation || []).map(r => r.id);
  const urlProp = (p, n) => p?.properties?.[n]?.url || null;
  const files = (p, n) => (p?.properties?.[n]?.files || [])
    .map(f => ({ nom: f.name, url: f.file?.url || f.external?.url || null }))
    .filter(f => f.url);

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
    const sessions = await queryAll(SESSIONS_DB, {
      sorts: [{ property: "Date début", direction: "ascending" }],
    });

    const participantIds = [...new Set(sessions.flatMap(s => rel(s, "Participants")))];
    const formationIds = [...new Set(sessions.flatMap(s => rel(s, "Formation")))];
    const entrepriseIds = [...new Set(sessions.flatMap(s => rel(s, "Entreprise")))];
    const [participants, formations, entreprises] = await Promise.all([
      fetchPages(participantIds), fetchPages(formationIds), fetchPages(entrepriseIds),
    ]);

    // Émargements signés
    const emargements = await queryAll(EMARGEMENTS_DB, {
      filter: { property: "Signé", checkbox: { equals: true } },
    });
    const signCount = {};
    for (const e of emargements) {
      for (const pid of rel(e, "Participant")) signCount[pid] = (signCount[pid] || 0) + 1;
    }

    // Fiches d'évaluation → scores
    const evalIds = [...new Set(participantIds.flatMap(pid => {
      const p = participants[pid];
      return p ? rel(p, "📊 Évaluation") : [];
    }))];
    const evalPages = await fetchPages(evalIds);

    // Parmi plusieurs fiches liées, garde la fiche complétée la plus récente
    const pickEval = (pages) => {
      const scored = pages.filter(Boolean).map(p => ({
        p,
        complete: p.properties?.["Complété"]?.checkbox ? 1 : 0,
        d: p.properties?.["Date soumission"]?.date?.start || p.created_time || "",
      }));
      scored.sort((a, b) => (b.complete - a.complete) || (a.d < b.d ? 1 : -1));
      return scored[0]?.p || null;
    };

    const payload = sessions.map(s => {
      const fId = rel(s, "Formation")[0];
      const f = fId ? formations[fId] : null;
      const eId = rel(s, "Entreprise")[0];
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
        adresse: text(s, "Adresse complète"),
        lienVisio: urlProp(s, "Lien classe virtuelle"),
        modalite: sel(s, "Modalité"),
        type: sel(s, "Type"),
        statut: sel(s, "Statut"),
        convocationEnvoyee: check(s, "Convocation envoyée"),
        entreprise: eId && entreprises[eId] ? anyTitle(entreprises[eId]) : "",
        rapport: {
          complete: check(s, "Rapport complété"),
          date: date(s, "Date rapport"),
          deroule: text(s, "Rapport: déroulé & adaptations"),
          pointsForts: text(s, "Rapport: points forts"),
          difficultes: text(s, "Rapport: difficultés & solutions"),
          ameliorations: text(s, "Rapport: axes d'amélioration"),
        },
        ressources: {
          programme: f ? files(f, "Programme PDF") : [],
          supportParticipant: f ? files(f, "Support participant") : [],
          convention: files(s, "Convention signée"),
          supportsPerso: files(s, "Supports personnalisés"),
        },
        formation: f ? {
          id: fId,
          nom: title(f, "Nom de la formation"),
          code: text(f, "Code formation"),
          notionUrl: f.url,
        } : null,
        participants: rel(s, "Participants").map(pid => {
          const p = participants[pid];
          if (!p) return null;
          const evalRec = pickEval(rel(p, "📊 Évaluation").map(id => evalPages[id]).filter(Boolean));
          const evalRecId = evalRec ? evalRec.id : null;
          return {
            id: pid.replace(/-/g, ""),
            nom: title(p, "Nom complet"),
            email: p.properties?.["Email"]?.email || "",
            positionnement: check(p, "Positionnement complété"),
            evaluation: check(p, "Évaluation complétée"),
            satisfaction: check(p, "Satisfaction complétée"),
            emargementsSignes: signCount[pid] || 0,
            posRecId: (rel(p, "📋 Positionnement")[0] || "").replace(/-/g, "") || null,
            evalRecId: (evalRecId || "").replace(/-/g, "") || null,
            satRecId: (rel(p, "😊 Satisfaction")[0] || "").replace(/-/g, "") || null,
            scoreEcrit: evalRec ? num(evalRec, "Score écrit (70%)") : null,
            scoreFormateur: evalRec ? num(evalRec, "Score formateur (30%)") : null,
            commentaireFormateur: evalRec ? text(evalRec, "Commentaire formateur") : "",
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
