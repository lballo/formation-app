/**
 * ═══════════════════════════════════════════════════════════
 *  API : Évaluation de fin de formation (Qualiopi — Ind. 11)
 *  Endpoint : /api/evaluation
 *
 *  GET  ?token=xxx  → Questions de la formation du stagiaire
 *                     (SANS les bonnes réponses, options mélangées)
 *  POST             → Corrige côté serveur, calcule le score,
 *                     écrit dans 📊 Évaluations, coche le participant
 *
 *  Les questions sont pilotées par la BDD ❓ Questions (Config
 *  formulaires) : ajouter une formation = remplir des lignes Notion,
 *  zéro code à modifier. La correction ne quitte jamais le serveur.
 * ═══════════════════════════════════════════════════════════
 */

const PARTICIPANTS_DB = "2fd075e127d281108567d716b7d6b3e1";
const QUESTIONS_DB = "bd330089b7ea47dd93c014e0f735f308";
const EVALUATIONS_DB = "2fd075e127d2812ca985d147b142e960";

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
  const text = (p, n) => (p?.properties?.[n]?.rich_text || []).map(t => t.plain_text).join("");
  const num = (p, n) => p?.properties?.[n]?.number ?? null;
  const check = (p, n) => !!p?.properties?.[n]?.checkbox;
  const rel = (p, n) => (p?.properties?.[n]?.relation || []).map(r => r.id);
  const rt = (s) => s ? [{ text: { content: String(s).slice(0, 1900) } }] : [];
  // rich_text long : découpé en blocs de 1900 caractères (évite la troncature du JSON)
  const rtLong = (s) => {
    const str = String(s || ""); const out = [];
    for (let i = 0; i < str.length && out.length < 90; i += 1900) out.push({ text: { content: str.slice(i, i + 1900) } });
    return out;
  };
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  async function loadContext(token) {
    const pageId = token.replace(/-/g, "");
    const participant = await getPage(pageId);
    if (!participant || participant.object === "error") return { error: "Token invalide" };
    if ((participant.parent?.database_id || "").replace(/-/g, "") !== PARTICIPANTS_DB) {
      return { error: "Token invalide" };
    }
    let formationId = null, formationNom = "", sessionInfo = null;
    const sessionId = rel(participant, "📅 Sessions")[0];
    if (sessionId) {
      const session = await getPage(sessionId);
      if (session) {
        sessionInfo = {
          code: text(session, "Code session"),
          dateDebut: session.properties?.["Date début"]?.date?.start || null,
          dateFin: session.properties?.["Date fin"]?.date?.start || null,
        };
        formationId = rel(session, "Formation")[0] || null;
      }
      if (formationId) {
        const formation = await getPage(formationId);
        formationNom = title(formation, "Nom de la formation");
      }
    }
    return {
      participant: { id: participant.id, nom: title(participant, "Nom complet") },
      formationId, formationNom, session: sessionInfo,
      evalRecIds: rel(participant, "📊 Évaluation"),
      dejaComplete: !!participant.properties?.["Évaluation complétée"]?.checkbox,
    };
  }

  // Questions actives d'Évaluation pour une formation (AVEC bonnes réponses — usage serveur)
  async function loadQuestions(formationId) {
    const r = await fetch(`https://api.notion.com/v1/databases/${QUESTIONS_DB}/query`, {
      method: "POST", headers: notionHeaders,
      body: JSON.stringify({
        filter: { and: [
          { property: "Formation", relation: { contains: formationId } },
          { property: "Type questionnaire", select: { equals: "Évaluation" } },
          { property: "Actif", checkbox: { equals: true } },
        ]},
        sorts: [{ property: "Ordre", direction: "ascending" }],
        page_size: 100,
      }),
    });
    if (!r.ok) return [];
    const data = await r.json();
    return data.results.map(q => ({
      id: q.id,
      question: title(q, "Question"),
      options: text(q, "Options").split("|").map(o => o.trim()).filter(Boolean),
      bonneReponse: text(q, "Bonne réponse").trim(),
      points: num(q, "Points") || 1,
      preTest: check(q, "Inclure au pré-test"),
    }));
  }

  // Lit un rich_text long via l'endpoint property items (paginé, non tronqué)
  async function readLongText(pageId, propId) {
    let out = "", cursor = null;
    do {
      const url = `https://api.notion.com/v1/pages/${pageId}/properties/${propId}?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`;
      const r = await fetch(url, { headers: notionHeaders });
      if (!r.ok) break;
      const data = await r.json();
      for (const it of data.results || []) out += it.rich_text?.plain_text || "";
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return out;
  }

  // Parmi plusieurs fiches liées, garde la fiche complétée la plus récente
  // (une fiche vide peut traîner dans la relation : création manuelle, test…)
  const pickEval = (pages) => {
    const scored = pages.filter(Boolean).map(p => ({
      p,
      complete: !!p.properties?.["Complété"]?.checkbox ? 1 : 0,
      date: p.properties?.["Date soumission"]?.date?.start || p.created_time || "",
    }));
    scored.sort((a, b) => (b.complete - a.complete) || (a.date < b.date ? 1 : -1));
    return scored[0]?.p || null;
  };

  // ═══════ GET ?mode=questionnaire : questions pour PDF vierge/corrigé ═══════
  // Protégé par la clé formateur : le corrigé contient les bonnes réponses,
  // et même la version vierge n'a pas vocation à être un endpoint public.
  if (req.method === "GET" && req.query.mode === "questionnaire") {
    const SECRET = process.env.DASHBOARD_SECRET;
    if (!SECRET || req.query.key !== SECRET) return res.status(401).json({ error: "Accès refusé" });
    const formationId = req.query.formation;
    if (!formationId) return res.status(400).json({ error: "Formation manquante" });
    try {
      const formation = await getPage(formationId.replace(/-/g, ""));
      if (!formation || formation.object === "error") return res.status(404).json({ error: "Formation introuvable" });
      const nom = title(formation, "Nom de la formation");
      const questions = await loadQuestions(formation.id);
      if (!questions.length) return res.status(404).json({ error: "Aucune question configurée pour cette formation" });
      const corrige = req.query.corrige === "1";
      return res.status(200).json({
        formation: nom,
        corrige,
        totalPoints: questions.reduce((t, q) => t + q.points, 0),
        questions: questions.map(q => ({
          question: q.question,
          options: q.options,          // ordre d'origine, non mélangé (impression)
          points: q.points,
          ...(corrige ? { bonneReponse: q.bonneReponse } : {}),
        })),
      });
    } catch (e) { console.error(e); return res.status(500).json({ error: "Erreur serveur" }); }
  }

  // ═══════ GET ?mode=resultats : résultats consolidés (page PDF) ═══════
  if (req.method === "GET" && req.query.mode === "resultats") {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: "Token manquant" });
    try {
      const ctx = await loadContext(token);
      if (ctx.error) return res.status(404).json({ error: ctx.error });
      if (!ctx.dejaComplete || !ctx.evalRecIds.length) {
        return res.status(404).json({ error: "Évaluation non complétée", nonComplete: true });
      }
      const evalPage = pickEval(await Promise.all(ctx.evalRecIds.map(getPage)));
      if (!evalPage) return res.status(404).json({ error: "Fiche d'évaluation introuvable" });
      const evalPageId = evalPage.id;

      // JSON complet via property items (les rich_text du getPage peuvent être tronqués)
      const jsonPropId = evalPage.properties?.["Réponses JSON"]?.id;
      let details = null;
      if (jsonPropId) {
        try { details = JSON.parse(await readLongText(evalPageId, jsonPropId)); } catch { details = null; }
      }
      const resumePropId = evalPage.properties?.["Réponses écrit"]?.id;
      const resume = (!details && resumePropId) ? await readLongText(evalPageId, resumePropId) : null;

      return res.status(200).json({
        participant: { nom: ctx.participant.nom },
        formation: ctx.formationNom,
        session: ctx.session,
        evaluation: {
          dateSoumission: evalPage.properties?.["Date soumission"]?.date?.start || null,
          scoreEcrit: num(evalPage, "Score écrit (70%)"),
          scoreFormateur: num(evalPage, "Score formateur (30%)"),
          scoreTotal: evalPage.properties?.["Score total"]?.formula?.number ?? null,
          commentaireFormateur: text(evalPage, "Commentaire formateur"),
          details,          // [{question, choix, bonneReponse, correct, points}] ou null
          resume,           // texte de secours pour les anciennes fiches au JSON tronqué
        },
      });
    } catch (e) { console.error(e); return res.status(500).json({ error: "Erreur serveur" }); }
  }

  // ═══════════════ GET : servir le questionnaire ═══════════════
  if (req.method === "GET") {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: "Token manquant" });
    try {
      const ctx = await loadContext(token);
      if (ctx.error) return res.status(404).json({ error: ctx.error });
      if (!ctx.formationId) return res.status(404).json({ error: "Aucune formation associée à votre session" });

      const questions = await loadQuestions(ctx.formationId);
      if (!questions.length) return res.status(404).json({ error: "Aucune question configurée pour cette formation" });

      return res.status(200).json({
        participant: ctx.participant,
        formation: ctx.formationNom,
        dejaComplete: ctx.dejaComplete,
        // ⚠️ jamais de bonne réponse côté client
        questions: questions.map(q => ({ id: q.id, question: q.question, options: shuffle([...q.options]) })),
      });
    } catch (e) { console.error(e); return res.status(500).json({ error: "Erreur serveur" }); }
  }

  // ═══════════════ POST : corriger et enregistrer ═══════════════
  if (req.method === "POST") {
    try {
      const { token, reponses } = req.body || {};
      if (!token || !reponses || typeof reponses !== "object") {
        return res.status(400).json({ error: "Champs manquants" });
      }
      const ctx = await loadContext(token);
      if (ctx.error) return res.status(404).json({ error: ctx.error });
      if (ctx.dejaComplete) return res.status(409).json({ error: "Évaluation déjà transmise" });
      if (!ctx.formationId) return res.status(404).json({ error: "Aucune formation associée" });

      const questions = await loadQuestions(ctx.formationId);
      if (!questions.length) return res.status(404).json({ error: "Aucune question configurée" });

      // Correction côté serveur
      let score = 0, totalPoints = 0;
      const details = questions.map(q => {
        totalPoints += q.points;
        const choix = String(reponses[q.id] || "").trim();
        const correct = choix === q.bonneReponse;
        if (correct) score += q.points;
        return { question: q.question, choix, bonneReponse: q.bonneReponse, correct, points: q.points };
      });
      const ratio = totalPoints ? score / totalPoints : 0;
      const now = new Date().toISOString();
      const resume = details.map((d, i) => `Q${i + 1} ${d.correct ? "✓" : "✗"} — ${d.question} → ${d.choix || "(sans réponse)"}`).join("\n");

      const create = await fetch("https://api.notion.com/v1/pages", {
        method: "POST", headers: notionHeaders,
        body: JSON.stringify({
          parent: { database_id: EVALUATIONS_DB },
          properties: {
            "Name": { title: [{ text: { content: `Évaluation — ${ctx.participant.nom}` } }] },
            "Participant": { relation: [{ id: ctx.participant.id }] },
            "Date soumission": { date: { start: now } },
            "Score écrit (70%)": { number: Math.round(ratio * 100) / 100 },
            "Réponses écrit": { rich_text: rt(resume) },
            "Réponses JSON": { rich_text: rtLong(JSON.stringify(details)) },
            "Complété": { checkbox: true },
          },
        }),
      });
      if (!create.ok) { console.error(await create.text()); return res.status(500).json({ error: "Échec de l'enregistrement" }); }

      // ✅ Coche automatique (zéro Make.com)
      await fetch(`https://api.notion.com/v1/pages/${ctx.participant.id}`, {
        method: "PATCH", headers: notionHeaders,
        body: JSON.stringify({ properties: { "Évaluation complétée": { checkbox: true } } }),
      });

      return res.status(200).json({
        ok: true, score, totalPoints,
        percent: Math.round(ratio * 100),
        details: details.map(d => ({ question: d.question, choix: d.choix, bonneReponse: d.bonneReponse, correct: d.correct })),
      });
    } catch (e) { console.error(e); return res.status(500).json({ error: "Erreur serveur" }); }
  }

  return res.status(405).json({ error: "Méthode non autorisée" });
}
