/**
 * ═══════════════════════════════════════════════════════════
 *  API : Satisfaction Formation (Qualiopi — Évaluation à chaud)
 *  Endpoint : /api/satisfaction-formation
 *
 *  GET  ?token=xxx  → Valide le token (= ID page Participant Notion)
 *  POST             → Enregistre l'évaluation dans la BDD Satisfaction
 *
 *  Le token est l'ID de page Notion du participant.
 *  Le champ formule "Lien satisfaction" dans la BDD Participants
 *  génère automatiquement l'URL complète :
 *  https://formation.lauraballo.com/satisfaction-formation?token={id}
 *
 *  BDD Notion :
 *  - 👥 Participants   (2fd075e127d281108567d716b7d6b3e1)
 *  - 😊 Satisfaction    (2fd075e127d28173b179cfb3a4c0fc95)
 *  - 📅 Sessions        (relation depuis Participants)
 *  - 📚 Formations      (relation depuis Sessions)
 * ═══════════════════════════════════════════════════════════
 */

export default async function handler(req, res) {
  // ── CORS ──
  res.setHeader("Access-Control-Allow-Origin", "https://formation.lauraballo.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  const SATISFACTION_DB = "2fd075e127d28173b179cfb3a4c0fc95";

  if (!NOTION_API_KEY) {
    return res.status(500).json({ error: "Clé API manquante" });
  }

  const notionHeaders = {
    "Authorization": `Bearer ${NOTION_API_KEY}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };

  // ── Helpers Notion ──
  async function notionGetPage(pageId) {
    const response = await fetch(
      `https://api.notion.com/v1/pages/${pageId}`,
      { headers: notionHeaders }
    );
    if (!response.ok) return null;
    return response.json();
  }

  async function notionCreatePage(databaseId, properties) {
    return fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: notionHeaders,
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties,
      }),
    });
  }

  async function notionPatchPage(pageId, properties) {
    return fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: notionHeaders,
      body: JSON.stringify({ properties }),
    });
  }

  function getText(page, propName, propType = "rich_text") {
    const prop = page?.properties?.[propName];
    if (!prop) return "";
    if (propType === "title") {
      return prop.title?.[0]?.plain_text || "";
    }
    return prop.rich_text?.[0]?.plain_text || "";
  }

  // ═══════════════════════════════════════════════════════
  // GET ?mode=resultats : réponses consolidées (page PDF)
  // ═══════════════════════════════════════════════════════
  if (req.method === "GET" && req.query.mode === "resultats") {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: "Token manquant" });
    const pageId = token.replace(/-/g, "");

    // Concatène tous les blocs rich_text (textes longs)
    const rtAll = (page, propName) =>
      (page?.properties?.[propName]?.rich_text || [])
        .map(b => b.plain_text || "")
        .join("");
    const numProp = (page, propName) =>
      page?.properties?.[propName]?.number ?? null;
    const anyTitle = (page) => {
      for (const p of Object.values(page?.properties || {})) {
        if (p.type === "title") return p.title?.[0]?.plain_text || "";
      }
      return "";
    };

    try {
      const participant = await notionGetPage(pageId);
      if (!participant || participant.object === "error") {
        return res.status(404).json({ error: "Token invalide" });
      }
      const parentDb = participant.parent?.database_id?.replace(/-/g, "");
      if (parentDb !== "2fd075e127d281108567d716b7d6b3e1") {
        return res.status(404).json({ error: "Token invalide" });
      }

      const complete =
        participant.properties["Satisfaction complétée"]?.checkbox || false;
      const ficheRefs =
        participant.properties["😊 Satisfaction"]?.relation || [];
      if (!complete || !ficheRefs.length) {
        return res
          .status(404)
          .json({ error: "Questionnaire non complété", nonComplete: true });
      }

      // Parmi plusieurs fiches liées, garde la plus récente réellement remplie
      const fiches = (
        await Promise.all(ficheRefs.map(r => notionGetPage(r.id)))
      ).filter(
        p =>
          p &&
          p.object !== "error" &&
          p.parent?.database_id?.replace(/-/g, "") === SATISFACTION_DB
      );
      if (!fiches.length) {
        return res.status(404).json({ error: "Fiche de satisfaction introuvable" });
      }
      const scored = fiches.map(p => ({
        p,
        filled: numProp(p, "Professionnalisme formateur") != null ? 1 : 0,
        d: p.properties?.["Date soumission"]?.date?.start || p.created_time || "",
      }));
      scored.sort((a, b) => (b.filled - a.filled) || (a.d < b.d ? 1 : -1));
      const fiche = scored[0].p;

      // Contexte : session → formation + entreprise (pour l'en-tête du document)
      const nomComplet = getText(participant, "Nom complet", "title");
      let formationName = "";
      let session = null;
      const sessions = participant.properties["📅 Sessions"]?.relation || [];
      if (sessions.length > 0) {
        const sp = await notionGetPage(sessions[0].id);
        if (sp) {
          session = {
            titre: getText(sp, "Titre formation", "title"),
            code: getText(sp, "Code session"),
            dateDebut: sp.properties?.["Date début"]?.date?.start || null,
            dateFin: sp.properties?.["Date fin"]?.date?.start || null,
            lieu: getText(sp, "Lieu"),
            entreprise: "",
          };
          const eRefs = sp.properties?.["Entreprise"]?.relation || [];
          if (eRefs.length) {
            const ep = await notionGetPage(eRefs[0].id);
            if (ep && ep.object !== "error") session.entreprise = anyTitle(ep);
          }
          const fRefs = sp.properties?.["Formation"]?.relation || [];
          if (fRefs.length) {
            const fp = await notionGetPage(fRefs[0].id);
            if (fp && fp.object !== "error") {
              formationName = getText(fp, "Nom de la formation", "title");
            }
          }
        }
      }

      return res.status(200).json({
        participant: { nom: nomComplet },
        formation: formationName || session?.titre || "",
        session,
        satisfaction: {
          dateSoumission:
            fiche.properties?.["Date soumission"]?.date?.start || null,
          notes: {
            accueilPausesRepas: numProp(fiche, "Accueil / Pauses / Repas"),
            confortSalle: numProp(fiche, "Confort salle"),
            respectProgramme: numProp(fiche, "Respect du programme"),
            utiliteProfessionnelle: numProp(fiche, "Utilité professionnelle"),
            qualitePedagogie: numProp(fiche, "Qualité pédagogie"),
            moyensPedagogiques: numProp(fiche, "Moyens pédagogiques"),
            professionnalismeFormateur: numProp(fiche, "Professionnalisme formateur"),
          },
          avisFormation: rtAll(fiche, "Avis formation"),
          commentairesLibres: rtAll(fiche, "Commentaires libres"),
          accepteTemoignage:
            fiche.properties?.["Accepte témoignage"]?.checkbox || false,
          fonction: rtAll(fiche, "Fonction"),
        },
      });
    } catch (err) {
      console.error("GET resultats error:", err);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }

  // ═══════════════════════════════════════════════════════
  // GET : Validation du token (= ID page participant)
  // ═══════════════════════════════════════════════════════
  if (req.method === "GET") {
    const token = req.query.token;
    if (!token) {
      return res.status(400).json({ error: "Token manquant" });
    }

    // Normaliser le token (retirer les tirets si présents)
    const pageId = token.replace(/-/g, "");

    try {
      // 1. Fetch direct de la page participant par son ID
      const participant = await notionGetPage(pageId);

      if (!participant || participant.object === "error") {
        return res.status(404).json({ error: "Token invalide" });
      }

      // Vérifier que c'est bien une page de la BDD Participants
      const parentDb = participant.parent?.database_id?.replace(/-/g, "");
      if (parentDb !== "2fd075e127d281108567d716b7d6b3e1") {
        return res.status(404).json({ error: "Token invalide" });
      }

      // 2. Vérifier si déjà complété
      const satisfactionCompletee =
        participant.properties["Satisfaction complétée"]?.checkbox || false;
      if (satisfactionCompletee) {
        return res.status(409).json({
          error: "Évaluation déjà soumise",
          alreadyCompleted: true,
        });
      }

      // 3. Infos participant
      const prenom = getText(participant, "Prénom");
      const nomComplet = getText(participant, "Nom complet", "title");

      // 4. Remonter : Participant → Session → Formation
      let formationName = "";
      let sessionInfo = "";

      const sessions =
        participant.properties["📅 Sessions"]?.relation || [];
      if (sessions.length > 0) {
        const sessionPage = await notionGetPage(sessions[0].id);
        if (sessionPage) {
          sessionInfo =
            getText(sessionPage, "Titre formation", "title") || "";

          const formations =
            sessionPage.properties?.["Formation"]?.relation || [];
          if (formations.length > 0) {
            const formationPage = await notionGetPage(formations[0].id);
            if (formationPage) {
              formationName =
                getText(
                  formationPage,
                  "Nom de la formation",
                  "title"
                ) || "";
            }
          }
        }
      }

      return res.status(200).json({
        valid: true,
        participantId: participant.id,
        prenom,
        nomComplet,
        formation: formationName || sessionInfo || "",
        sessionInfo,
      });
    } catch (err) {
      console.error("GET error:", err);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }

  // ═══════════════════════════════════════════════════════
  // POST : Enregistrement de l'évaluation
  // ═══════════════════════════════════════════════════════
  if (req.method === "POST") {
    const {
      token: bodyToken,
      participantId,
      prenom,
      accueilPausesRepas,
      confortSalle,
      respectProgramme,
      utiliteProfessionnelle,
      qualitePedagogie,
      moyensPedagogiques,
      professionnalismeFormateur,
      avisFormation,
      commentairesLibres,
      accepteTemoignage,
      fonction,
    } = req.body;

    if (!participantId || !professionnalismeFormateur) {
      return res
        .status(400)
        .json({ error: "Champs obligatoires manquants" });
    }

    const titre = prenom
      ? `${prenom} — Évaluation à chaud`
      : "Évaluation à chaud";

    const properties = {
      "Identifiant": {
        title: [{ text: { content: titre } }],
      },
      "Accueil / Pauses / Repas": {
        number: parseInt(accueilPausesRepas),
      },
      "Confort salle": {
        number: parseInt(confortSalle),
      },
      "Respect du programme": {
        number: parseInt(respectProgramme),
      },
      "Utilité professionnelle": {
        number: parseInt(utiliteProfessionnelle),
      },
      "Qualité pédagogie": {
        number: parseInt(qualitePedagogie),
      },
      "Moyens pédagogiques": {
        number: parseInt(moyensPedagogiques),
      },
      "Professionnalisme formateur": {
        number: parseInt(professionnalismeFormateur),
      },
      "Avis formation": {
        rich_text: [{ text: { content: avisFormation || "" } }],
      },
      "Commentaires libres": {
        rich_text: [
          { text: { content: commentairesLibres || "" } },
        ],
      },
      "Accepte témoignage": {
        checkbox: accepteTemoignage === true,
      },
      "Participant": {
        relation: [{ id: participantId }],
      },
      "Date soumission": {
        date: { start: new Date().toISOString().split("T")[0] },
      },
    };

    // Sauvegarder la fonction si fournie
    if (fonction) {
      properties["Fonction"] = {
        rich_text: [{ text: { content: fonction } }],
      };
    }

    try {
      // 1. Créer l'entrée dans la BDD Satisfaction
      const createResponse = await notionCreatePage(
        SATISFACTION_DB,
        properties
      );

      if (!createResponse.ok) {
        const error = await createResponse.json();
        console.error("Notion create error:", error);
        return res
          .status(500)
          .json({ error: "Erreur Notion", detail: error });
      }

      // 2. Marquer "Satisfaction complétée" dans Participants
      await notionPatchPage(participantId, {
        "Satisfaction complétée": { checkbox: true },
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("POST error:", err);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
