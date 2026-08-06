/**
 * ═══════════════════════════════════════════════════════════
 *  API : Rapport de session (bilan formateur — Ind. 30 & 32)
 *  Endpoint : /api/rapport   (POST, protégé par DASHBOARD_SECRET)
 *
 *  Enregistre le bilan de la formatrice dans la fiche Session :
 *  déroulé & adaptations, points forts, difficultés, axes
 *  d'amélioration. Coche "Rapport complété" + date.
 *  Ré-appelable pour modifier un rapport existant.
 * ═══════════════════════════════════════════════════════════
 */

const SESSIONS_DB = "2fd075e127d281d5a34bdeacdc88c160";
const EVALUATIONS_DB = "2fd075e127d2812ca985d147b142e960";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const SECRET = process.env.DASHBOARD_SECRET;
  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  if (!NOTION_API_KEY) return res.status(500).json({ error: "Configuration manquante" });

  const { key, sessionId, deroule, pointsForts, difficultes, ameliorations, evaluations } = req.body || {};
  if (!SECRET || key !== SECRET) return res.status(401).json({ error: "Accès refusé" });
  if (!sessionId) return res.status(400).json({ error: "sessionId manquant" });
  const hasRapport = !!(deroule || pointsForts || difficultes || ameliorations);
  const hasEvals = Array.isArray(evaluations) && evaluations.length > 0;
  if (!hasRapport && !hasEvals) {
    return res.status(400).json({ error: "Rien à enregistrer" });
  }

  const notionHeaders = {
    "Authorization": `Bearer ${NOTION_API_KEY}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };
  const rt = (s) => {
    const out = [];
    const str = String(s || "");
    for (let i = 0; i < str.length && out.length < 20; i += 1900) out.push({ text: { content: str.slice(i, i + 1900) } });
    return out;
  };

  try {
    // Vérifie que la page est bien une session
    const check = await fetch(`https://api.notion.com/v1/pages/${sessionId.replace(/-/g, "")}`, { headers: notionHeaders });
    if (!check.ok) return res.status(404).json({ error: "Session introuvable" });
    const page = await check.json();
    if ((page.parent?.database_id || "").replace(/-/g, "") !== SESSIONS_DB) {
      return res.status(400).json({ error: "Cette page n'est pas une session" });
    }

    if (hasRapport) {
      const patch = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
        method: "PATCH", headers: notionHeaders,
        body: JSON.stringify({
          properties: {
            "Rapport: déroulé & adaptations": { rich_text: rt(deroule) },
            "Rapport: points forts": { rich_text: rt(pointsForts) },
            "Rapport: difficultés & solutions": { rich_text: rt(difficultes) },
            "Rapport: axes d'amélioration": { rich_text: rt(ameliorations) },
            "Rapport complété": { checkbox: true },
            "Date rapport": { date: { start: new Date().toISOString() } },
          },
        }),
      });
      if (!patch.ok) { console.error(await patch.text()); return res.status(500).json({ error: "Échec de l'enregistrement du rapport" }); }
    }

    // ── Évaluations formateur : score (30 %) + commentaire individuel ──
    if (hasEvals) {
      const errors = [];
      for (const ev of evaluations.slice(0, 50)) {
        const evalId = String(ev.evalRecId || "").replace(/-/g, "");
        if (!evalId) continue;
        // Vérifie que la page appartient bien à la base Évaluations
        const chk = await fetch(`https://api.notion.com/v1/pages/${evalId}`, { headers: notionHeaders });
        if (!chk.ok) { errors.push(evalId); continue; }
        const evPage = await chk.json();
        if ((evPage.parent?.database_id || "").replace(/-/g, "") !== EVALUATIONS_DB) { errors.push(evalId); continue; }

        const props = {};
        if (ev.scoreFormateur != null && !Number.isNaN(Number(ev.scoreFormateur))) {
          props["Score formateur (30%)"] = { number: Math.min(1, Math.max(0, Number(ev.scoreFormateur))) };
        }
        if (typeof ev.commentaire === "string") {
          props["Commentaire formateur"] = { rich_text: rt(ev.commentaire) };
        }
        if (!Object.keys(props).length) continue;
        const up = await fetch(`https://api.notion.com/v1/pages/${evPage.id}`, {
          method: "PATCH", headers: notionHeaders,
          body: JSON.stringify({ properties: props }),
        });
        if (!up.ok) { console.error(await up.text()); errors.push(evalId); }
      }
      if (errors.length) return res.status(207).json({ ok: false, error: `${errors.length} évaluation(s) non enregistrée(s)` });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}
