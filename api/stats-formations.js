/**
 * ═══════════════════════════════════════════════════════════
 *  API : Statistiques satisfaction par formation (Ind. 2)
 *  Endpoint : /api/stats-formations   (GET, public, cache 1h)
 *
 *  Agrège les questionnaires à chaud :
 *  - moyenne /10 et nombre d'avis PAR FORMATION (et global)
 *  - témoignages autorisés (max 3 par formation)
 *
 *  Consommé par :
 *  - les pages formations de lauraballo.com (remplace les
 *    avis codés en dur — point de vigilance audit Ind. 2)
 *  - le dashboard formateur (métrique satisfaction)
 *
 *  Chaîne de résolution : Satisfaction → Participant → Session
 *  → Formation. Aucune donnée personnelle exposée.
 * ═══════════════════════════════════════════════════════════
 */

const SESSIONS_DB = "2fd075e127d281d5a34bdeacdc88c160";
const SATISFACTION_DB = "2fd075e127d28173b179cfb3a4c0fc95";

const NOTE_FIELDS = [
  "Utilité professionnelle", "Qualité pédagogie", "Moyens pédagogiques",
  "Professionnalisme formateur", "Respect programme", "Respect du programme",
  "Confort salle", "Accueil / Pauses / Repas",
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  if (req.method !== "GET") return res.status(405).json({ error: "Méthode non autorisée" });

  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  if (!NOTION_API_KEY) return res.status(500).json({ error: "Configuration manquante" });

  const notionHeaders = {
    "Authorization": `Bearer ${NOTION_API_KEY}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };

  const title = (p, n) => p?.properties?.[n]?.title?.[0]?.plain_text || "";
  const text = (p, n) => (p?.properties?.[n]?.rich_text || []).map(t => t.plain_text).join("");
  const num = (p, n) => p?.properties?.[n]?.number ?? null;
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

  try {
    // 1. Sessions → mapping participant → formation
    const sessions = await queryAll(SESSIONS_DB);
    const participantToFormation = {};
    const formationIds = new Set();
    for (const s of sessions) {
      const fId = rel(s, "Formation")[0];
      if (!fId) continue;
      formationIds.add(fId);
      for (const pid of rel(s, "Participants")) participantToFormation[pid] = fId;
    }

    // 2. Infos formations (code, slug, nom)
    const formations = {};
    for (const fId of formationIds) {
      const f = await getPage(fId);
      if (f) formations[fId] = {
        code: text(f, "Code formation"),
        slug: text(f, "slug"),
        nom: title(f, "Nom de la formation"),
        notes: [], temoignages: [],
      };
    }

    // 3. Questionnaires de satisfaction → moyenne par réponse
    const rows = await queryAll(SATISFACTION_DB);
    let globalNotes = [];
    for (const row of rows) {
      const notes = NOTE_FIELDS.map(f => num(row, f)).filter(v => typeof v === "number" && v >= 1 && v <= 10);
      if (!notes.length) continue;
      const moyenne = notes.reduce((a, b) => a + b, 0) / notes.length;
      globalNotes.push(moyenne);

      const pid = rel(row, "Participant")[0];
      const fId = pid ? participantToFormation[pid] : null;
      if (fId && formations[fId]) {
        formations[fId].notes.push(moyenne);
        // Témoignage autorisé → publiable sur le site (anonymisé : fonction seule)
        const avis = text(row, "Avis formation").trim();
        if (avis && (check(row, "Témoignage autorisé") || check(row, "Accepte témoignage"))
            && formations[fId].temoignages.length < 3) {
          formations[fId].temoignages.push({
            texte: avis.slice(0, 400),
            fonction: text(row, "Fonction").trim() || "Participant·e",
          });
        }
      }
    }

    const round1 = v => Math.round(v * 10) / 10;
    const payload = {
      updatedAt: new Date().toISOString(),
      global: globalNotes.length
        ? { moyenne: round1(globalNotes.reduce((a, b) => a + b, 0) / globalNotes.length), nb: globalNotes.length }
        : { moyenne: null, nb: 0 },
      formations: Object.values(formations).map(f => ({
        code: f.code, slug: f.slug, nom: f.nom,
        moyenne: f.notes.length ? round1(f.notes.reduce((a, b) => a + b, 0) / f.notes.length) : null,
        nb: f.notes.length,
        temoignages: f.temoignages,
      })),
    };

    return res.status(200).json(payload);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}
