/**
 * ═══════════════════════════════════════════════════════════
 *  API : Questionnaire de positionnement (Qualiopi — Ind. 4 & 8)
 *  Endpoint : /api/positionnement          — VERSION 2 (pré-test)
 *
 *  GET  ?token=xxx  → Contexte + questions du pré-test de la
 *                     formation (sans les réponses, mélangées,
 *                     avec option « Je ne sais pas encore »)
 *  POST             → Réponses déclaratives + pré-test corrigé
 *                     côté serveur → Score QCM initial (Ind. 11 :
 *                     mesure de progression pré/post)
 *
 *  Le pré-test n'est jamais bloquant ni pénalisant : il sert à
 *  adapter la session et à mesurer la progression.
 * ═══════════════════════════════════════════════════════════
 */

const PARTICIPANTS_DB = "2fd075e127d281108567d716b7d6b3e1";
const POSITIONNEMENT_DB = "2fd075e127d281f2812efef8efcd5f21";
const QUESTIONS_DB = "bd330089b7ea47dd93c014e0f735f308";
const IDK = "Je ne sais pas encore";

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
  const rel = (p, n) => (p?.properties?.[n]?.relation || []).map(r => r.id);
  const rt = (s) => s ? [{ text: { content: String(s).slice(0, 1900) } }] : [];
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  async function loadContext(token) {
    const pageId = token.replace(/-/g, "");
    const participant = await getPage(pageId);
    if (!participant || participant.object === "error") return { error: "Token invalide" };
    if ((participant.parent?.database_id || "").replace(/-/g, "") !== PARTICIPANTS_DB) {
      return { error: "Token invalide" };
    }
    let sessionTitre = "", formationNom = "", formationId = null;
    const sessionId = rel(participant, "📅 Sessions")[0];
    if (sessionId) {
      const session = await getPage(sessionId);
      sessionTitre = title(session, "Titre formation");
      formationId = session ? rel(session, "Formation")[0] : null;
      if (formationId) {
        const formation = await getPage(formationId);
        formationNom = title(formation, "Nom de la formation");
      }
    }
    return {
      participant: { id: participant.id, nom: title(participant, "Nom complet") },
      session: sessionTitre,
      formation: formationNom || sessionTitre,
      formationId,
      dejaComplete: !!participant.properties?.["Positionnement complété"]?.checkbox,
    };
  }

  // Questions marquées « Inclure au pré-test » pour la formation
  async function loadPretest(formationId) {
    if (!formationId) return [];
    const r = await fetch(`https://api.notion.com/v1/databases/${QUESTIONS_DB}/query`, {
      method: "POST", headers: notionHeaders,
      body: JSON.stringify({
        filter: { and: [
          { property: "Formation", relation: { contains: formationId } },
          { property: "Type questionnaire", select: { equals: "Évaluation" } },
          { property: "Actif", checkbox: { equals: true } },
          { property: "Inclure au pré-test", checkbox: { equals: true } },
        ]},
        sorts: [{ property: "Ordre", direction: "ascending" }],
        page_size: 20,
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
    }));
  }

  // ═══════════════ GET ═══════════════
  if (req.method === "GET") {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: "Token manquant" });
    try {
      const ctx = await loadContext(token);
      if (ctx.error) return res.status(404).json({ error: ctx.error });
      const pretest = await loadPretest(ctx.formationId);
      return res.status(200).json({
        participant: ctx.participant,
        session: ctx.session,
        formation: ctx.formation,
        dejaComplete: ctx.dejaComplete,
        // ⚠️ sans les bonnes réponses ; « Je ne sais pas encore » toujours proposé
        pretest: pretest.map(q => ({ id: q.id, question: q.question, options: [...shuffle([...q.options]), IDK] })),
      });
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

      // Correction du pré-test côté serveur (non bloquant)
      let scoreProps = {};
      const pretest = await loadPretest(ctx.formationId);
      if (pretest.length && b.pretest && typeof b.pretest === "object") {
        let score = 0, total = 0;
        const lignes = pretest.map((q, i) => {
          total += q.points;
          const choix = String(b.pretest[q.id] || "").trim();
          const correct = choix === q.bonneReponse;
          if (correct) score += q.points;
          return `Q${i + 1} ${correct ? "✓" : "✗"} — ${q.question} → ${choix || "(sans réponse)"}`;
        });
        scoreProps = {
          "Score QCM initial": { number: total ? Math.round((score / total) * 100) / 100 : 0 },
          "Réponses QCM initial": { rich_text: rt(lignes.join("\n")) },
        };
      }

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
        ...scoreProps,
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
