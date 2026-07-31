const fs = require("fs");
const crypto = require("crypto");

const MAX_DIFF_CHARS = 12000;
const MAX_BODY_CHARS = 1000;
const MAX_FERMETURES = 3;     // 💰 c'est CELUI-CI qui pilote la facture
const MAX_RAISON_CHARS = 500; // 🛡️ borne la taille du commentaire posté
const MODELE = "gpt-4o-mini";

const [diffPath, issuesPath, outputPath] = process.argv.slice(2);
const apiKey = process.env.OPENAI_API_KEY;

if (!diffPath || !issuesPath || !outputPath) {
  console.error("Usage: node scripts/match-issues.js <diff.txt> <issues.json> <matches.json>");
  process.exit(1);
}

if (!apiKey) {
  console.error("OPENAI_API_KEY manquante.");
  process.exit(1);
}

function messageErreurHttp(status, corpsBrut) {
  return `HTTP ${status} - ${corpsBrut}`;
}

const consignesSysteme = `
Tu reçois :
- le diff d'une Pull Request mergée ;
- la liste des issues ouvertes.

Ta mission :
- identifier uniquement les issues qui sont très probablement résolues par ce diff ;
- être conservateur : en cas de doute, ne rien proposer.

Contraintes de sortie :
- répondre STRICTEMENT en JSON valide ;
- format attendu :
{
  "matches": [
    {
      "issue": 123,
      "raison": "explication courte"
    }
  ]
}

Règles impératives :
- ne propose que des numéros présents dans la liste d'issues fournie ;
- ne propose rien si le diff ne permet pas de conclure clairement ;
- la raison doit être courte, factuelle et exploitable.
`.trim();

// 1️⃣ Lecture + troncature
let diff = fs.readFileSync(diffPath, "utf-8");
if (diff.length > MAX_DIFF_CHARS) {
  diff = diff.slice(0, MAX_DIFF_CHARS) + "\n\n[… diff tronqué …]";
}

const issues = JSON.parse(fs.readFileSync(issuesPath, "utf-8"));

// 2️⃣ 🛡️ LA LISTE BLANCHE
const numerosAutorises = new Set(issues.map((issue) => issue.number));

// 3️⃣ 🛡️ Sérialisation JSON des issues
const listeIssues = JSON.stringify(
  issues.map((issue) => ({
    numero: issue.number,
    titre: String(issue.title || ""),
    description: String(issue.body || "(pas de description)").slice(0, MAX_BODY_CHARS),
  })),
  null,
  2
);

// 4️⃣ 🛡️ NONCE dans les balises
const nonce = crypto.randomUUID();
const baliseOuvrante = `<donnees_non_fiables_${nonce}>`;
const baliseFermante = `</donnees_non_fiables_${nonce}>`;

const contenuUtilisateur = `# Diff de la Pull Request mergée
\`\`\`diff
${diff}
\`\`\`

# Issues ouvertes à examiner (tableau JSON)
${baliseOuvrante}
${listeIssues}
${baliseFermante}
`;

// 5️⃣ Appel API
async function interrogerIA() {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODELE,
      messages: [
        {
          role: "system",
          content: consignesSysteme,
        },
        {
          role: "user",
          content: contenuUtilisateur,
        },
      ],
      response_format: {
        type: "json_object",
      },
      temperature: 0.2,
    }),
  });

  const corpsBrut = await response.text();

  if (!response.ok) {
    throw new Error(messageErreurHttp(response.status, corpsBrut));
  }

  const data = JSON.parse(corpsBrut); // 1er parse : enveloppe HTTP
  const contenu = data.choices?.[0]?.message?.content;

  if (typeof contenu !== "string" || contenu.trim() === "") {
    throw new Error("L'API a répondu 200 mais sans contenu exploitable.");
  }

  return JSON.parse(contenu); // 2e parse : JSON émis par le modèle
}

async function main() {
  const reponseModele = await interrogerIA();
  const proposees = Array.isArray(reponseModele.matches) ? reponseModele.matches : [];

  const retenues = [];

  // 6️⃣ 🛡️ VALIDATION — on ne fait aucune confiance à la réponse
  for (const proposition of proposees) {
    const valeur = proposition && proposition.issue;

    // On VÉRIFIE le type, on ne le CONVERTIT pas
    if (typeof valeur !== "number" || !Number.isInteger(valeur)) continue;
    if (!numerosAutorises.has(valeur)) continue; // hors liste
    if (retenues.some((r) => r.issue === valeur)) continue; // doublon

    retenues.push({
      issue: valeur,
      raison: String(proposition.raison || "…").slice(0, MAX_RAISON_CHARS),
    });
  }

  // 7️⃣ 🛡️ LE PLAFOND
  if (retenues.length > MAX_FERMETURES) {
    console.log(
      `::warning::${retenues.length} fermetures proposées > plafond ${MAX_FERMETURES}. Aucune issue fermée.`
    );
    retenues.length = 0;
  }

  const sortie = {
    matches: retenues,
  };

  fs.writeFileSync(outputPath, JSON.stringify(sortie, null, 2), "utf-8");
  console.log(`✅ ${retenues.length} issue(s) retenue(s). Résultat écrit dans ${outputPath}`);
}

main().catch((err) => {
  console.error("❌ Erreur :", err.message);
  process.exit(1);
});