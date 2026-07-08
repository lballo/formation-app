/**
 * ═══════════════════════════════════════════════════════════
 *  Agent Commercial Autonome v2 — Laura Ballo Coaching
 *  Endpoint : GET /api/agent-prospection?key=XXXX
 *
 *  Moteur : OpenAI (GPT-4o avec web search)
 *  Destination : 🔍 Prospects à valider (base tampon)
 *  Validation : manuelle dans Notion → Décision = "Validé"
 *  Transfert : /api/valider-prospects?key=XXXX
 *
 *  Variables d'environnement :
 *  - OPENAI_API_KEY
 *  - NOTION_API_KEY
 *  - DASHBOARD_SECRET
 * ═══════════════════════════════════════════════════════════
 */

const INSTRUCTIONS_PAGE = "397075e127d281b18b11c08b5b58945a";
const ENTREPRISES_DB    = "2fd075e127d281a8bb9b000b87733d9d";
const PROSPECTS_DB      = "633af2b6f78d4aeebaeaaee561b1eb7f";
const JOURNAL_DB        = "e702e72ebcc34f70a83607e83e468489";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "GET uniquement" });

  const SECRET = process.env.DASHBOARD_SECRET;
  if (!SECRET || req.query.key !== SECRET) return res.status(401).json({ error: "Clé invalide" });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  if (!OPENAI_API_KEY || !NOTION_API_KEY) return res.status(500).json({ error: "Clés API manquantes" });

  const t0 = Date.now();
  const notionH = {
    "Authorization": `Bearer ${NOTION_API_KEY}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };

  // ─── Utilitaires Notion ───

  async function getPageContent(pageId) {
    const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, { headers: notionH });
    if (!r.ok) return "";
    const data = await r.json();
    return data.results.map(b => {
      const t = b[b.type];
      return t?.rich_text ? t.rich_text.map(r => r.plain_text).join("") : "";
    }).filter(Boolean).join("\n");
  }

  async function queryAll(dbId, body = {}) {
    let results = [], cursor;
    do {
      const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: "POST", headers: notionH,
        body: JSON.stringify({ ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
      });
      if (!r.ok) break;
      const data = await r.json();
      results = results.concat(data.results);
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return results;
  }

  const title = (p, n) => p?.properties?.[n]?.title?.[0]?.plain_text || "";
  const rt = (s) => s ? [{ text: { content: String(s).slice(0, 1900) } }] : [];

  async function createProspect(p) {
    const props = {
      "Entreprise": { title: [{ text: { content: p.entreprise } }] },
      "Décision": { select: { name: "À valider" } },
      "Date trouvé": { date: { start: new Date().toISOString().slice(0, 10) } },
      "Transféré": { checkbox: false },
    };
    if (p.secteur) props["Secteur"] = { select: { name: p.secteur } };
    if (p.siteWeb) props["Site web"] = { url: p.siteWeb };
    if (p.adresse) props["Adresse"] = { rich_text: rt(p.adresse) };
    if (p.notesEntreprise) props["Notes entreprise"] = { rich_text: rt(p.notesEntreprise) };
    if (p.contactNom) props["Contact nom"] = { rich_text: rt(p.contactNom) };
    if (p.contactPrenom) props["Contact prénom"] = { rich_text: rt(p.contactPrenom) };
    if (p.contactFonction) props["Contact fonction"] = { rich_text: rt(p.contactFonction) };
    if (p.contactEmail && p.contactEmail !== "à trouver") props["Contact email"] = { email: p.contactEmail };
    if (p.contactTel) props["Contact téléphone"] = { phone_number: p.contactTel };
    if (p.contactLinkedin) props["Contact LinkedIn"] = { url: p.contactLinkedin };
    if (p.notesContact) props["Notes contact"] = { rich_text: rt(p.notesContact) };
    if (p.pertinence) props["Pertinence"] = { select: { name: p.pertinence } };
    if (p.justification) props["Justification"] = { rich_text: rt(p.justification) };
    if (p.sourceRecherche) props["Source recherche"] = { rich_text: rt(p.sourceRecherche) };

    await fetch("https://api.notion.com/v1/pages", {
      method: "POST", headers: notionH,
      body: JSON.stringify({ parent: { database_id: PROSPECTS_DB }, properties: props }),
    });
  }

  async function logExecution(log) {
    await fetch("https://api.notion.com/v1/pages", {
      method: "POST", headers: notionH,
      body: JSON.stringify({
        parent: { database_id: JOURNAL_DB },
        properties: {
          "Résumé": { title: [{ text: { content: log.resume } }] },
          "Date exécution": { date: { start: new Date().toISOString() } },
          "Prospects trouvés": { number: log.trouves },
          "Prospects ajoutés": { number: log.ajoutes },
          "Doublons évités": { number: log.doublons },
          "Requêtes effectuées": { rich_text: rt(log.requetes) },
          "Détail complet": { rich_text: rt(log.detail) },
          "Statut": { select: { name: log.statut } },
          "Durée (secondes)": { number: log.duree },
        },
      }),
    });
  }

  // ─── Exécution ───

  try {
    const instructions = await getPageContent(INSTRUCTIONS_PAGE);
    if (!instructions || instructions.length < 50) {
      return res.status(400).json({ error: "Instructions trop courtes ou page introuvable" });
    }

    // Anti-doublon : entreprises existantes + prospects déjà trouvés
    const [existing, pendingProspects] = await Promise.all([
      queryAll(ENTREPRISES_DB),
      queryAll(PROSPECTS_DB),
    ]);
    const existingNames = [
      ...existing.map(e => title(e, "Nom").toLowerCase().trim()),
      ...pendingProspects.map(e => title(e, "Entreprise").toLowerCase().trim()),
    ].filter(Boolean);

    // Appel OpenAI avec web search
    const systemPrompt = `Tu es un agent de prospection B2B pour Laura Ballo Coaching, un organisme de formation professionnelle certifié Qualiopi.

Ton rôle :
1. Sur la base des instructions ci-dessous, effectue des recherches web pour identifier des entreprises et contacts pertinents
2. Qualifie chaque prospect (pertinence Haute/Moyenne/Basse)
3. Retourne les résultats en JSON structuré

INSTRUCTIONS DE LAURA :
${instructions}

ENTREPRISES DÉJÀ CONNUES (NE PAS PROPOSER) :
${existingNames.slice(0, 150).join(", ") || "(aucune)"}

RÈGLES STRICTES :
- Ne propose JAMAIS une entreprise dont le nom est dans la liste ci-dessus
- Ne scrape JAMAIS LinkedIn directement
- Si tu ne trouves pas l'email public d'un contact, indique "à trouver" — n'invente JAMAIS
- Limite-toi au nombre de prospects indiqué dans les instructions (par défaut 5)
- Utilise des sources variées : sites institutionnels, annuaires, offres d'emploi, communiqués, presse locale

FORMAT DE RÉPONSE (JSON uniquement, sans markdown, sans backticks) :
{
  "recherches_effectuees": ["requête 1", "requête 2"],
  "prospects": [
    {
      "entreprise": "Nom",
      "secteur": "Un de : Santé & Bien-être, Industrie, Conseil & Services, Tech & Digital, Culture & Médias, Commerce & Distribution, Finance & Assurance, Immobilier, Autre",
      "site_web": "https://...",
      "adresse": "Ville",
      "notes_entreprise": "Pourquoi pertinent",
      "contact_nom": "NOM",
      "contact_prenom": "Prénom",
      "contact_fonction": "Responsable Formation",
      "contact_email": "email ou à trouver",
      "contact_telephone": "si trouvé ou null",
      "contact_linkedin": "URL ou null",
      "notes_contact": "Comment trouvé",
      "pertinence": "Haute",
      "justification": "Raison de la qualification",
      "source_recherche": "URL ou description de la source"
    }
  ],
  "resume": "Résumé en une phrase"
}`;

    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        tools: [{ type: "web_search_preview" }],
        instructions: systemPrompt,
        input: `Nous sommes le ${new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}. Lance tes recherches et trouve-moi de nouveaux prospects selon mes instructions. Varie tes angles de recherche : offres d'emploi RH, actualités formation, annuaires sectoriels, appels d'offres publics, articles de presse locale, sites d'entreprises...`,
      }),
    });

    if (!openaiResponse.ok) {
      const err = await openaiResponse.text();
      console.error("OpenAI error:", err);
      await logExecution({
        resume: "Erreur API OpenAI", trouves: 0, ajoutes: 0, doublons: 0,
        requetes: "", detail: err.slice(0, 1800), statut: "Erreur",
        duree: Math.round((Date.now() - t0) / 1000),
      });
      return res.status(502).json({ error: "Erreur API OpenAI" });
    }

    const openaiData = await openaiResponse.json();

    // Extraire le texte de la réponse OpenAI (format Responses API)
    let jsonText = "";
    if (openaiData.output) {
      for (const item of openaiData.output) {
        if (item.type === "message" && item.content) {
          for (const c of item.content) {
            if (c.type === "output_text") jsonText += c.text;
          }
        }
      }
    }

    // Nettoyer et parser
    jsonText = jsonText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    let result;
    try {
      result = JSON.parse(jsonText);
    } catch {
      const match = jsonText.match(/\{[\s\S]*\}/);
      if (match) result = JSON.parse(match[0]);
      else throw new Error("Impossible de parser la réponse : " + jsonText.slice(0, 500));
    }

    // Écrire dans la base tampon
    const prospects = result.prospects || [];
    let ajoutes = 0, doublons = 0;

    for (const p of prospects) {
      const nomLower = (p.entreprise || "").toLowerCase().trim();
      if (!nomLower) continue;

      if (existingNames.some(n => n.includes(nomLower) || nomLower.includes(n))) {
        doublons++;
        continue;
      }

      await createProspect({
        entreprise: p.entreprise,
        secteur: p.secteur,
        siteWeb: p.site_web,
        adresse: p.adresse,
        notesEntreprise: p.notes_entreprise,
        contactNom: p.contact_nom,
        contactPrenom: p.contact_prenom,
        contactFonction: p.contact_fonction,
        contactEmail: p.contact_email,
        contactTel: p.contact_telephone,
        contactLinkedin: p.contact_linkedin,
        notesContact: p.notes_contact,
        pertinence: p.pertinence,
        justification: p.justification,
        sourceRecherche: p.source_recherche,
      });
      ajoutes++;
      existingNames.push(nomLower);
    }

    const duree = Math.round((Date.now() - t0) / 1000);
    await logExecution({
      resume: result.resume || `${ajoutes} prospect(s) à valider`,
      trouves: prospects.length, ajoutes, doublons,
      requetes: (result.recherches_effectuees || []).join(" | "),
      detail: prospects.map(p => `${p.pertinence} — ${p.entreprise} (${p.secteur}) → ${p.contact_prenom} ${p.contact_nom}, ${p.contact_fonction}`).join("\n"),
      statut: ajoutes > 0 ? "Succès" : (prospects.length > 0 ? "Partiel" : "Erreur"),
      duree,
    });

    return res.status(200).json({
      ok: true, duree: `${duree}s`,
      prospects_trouves: prospects.length,
      en_attente_validation: ajoutes,
      doublons_evites: doublons,
      resume: result.resume,
    });

  } catch (e) {
    console.error("Agent error:", e);
    const duree = Math.round((Date.now() - t0) / 1000);
    await logExecution({
      resume: `Erreur : ${e.message?.slice(0, 100)}`,
      trouves: 0, ajoutes: 0, doublons: 0, requetes: "",
      detail: e.stack?.slice(0, 1800) || e.message, statut: "Erreur", duree,
    }).catch(() => {});
    return res.status(500).json({ error: e.message });
  }
}
