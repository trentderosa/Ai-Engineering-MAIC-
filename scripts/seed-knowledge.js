#!/usr/bin/env node
/**
 * Seed script for the MAIC knowledge base (maic-knowledge DynamoDB table).
 *
 * Usage:
 *   AWS_REGION=us-east-1 node scripts/seed-knowledge.js
 *
 * To add new entries, edit the ENTRIES array below and re-run.
 * To clear and re-seed: node scripts/seed-knowledge.js --reset
 *
 * Entry schema:
 *   pk      — unique ID: "<type>#<slug>"  e.g. "speaker#joe-holmes"
 *   type    — "speaker" | "event" | "note" | "topic"
 *   title   — display name shown in search results
 *   summary — 1-2 sentence summary returned in search results
 *   content — full text returned by get_knowledge_item (speaker notes, full agenda, etc.)
 *   tags    — array of lowercase keywords that improve search recall
 */

"use strict";

const { DynamoDBClient }                          = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, ScanCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

const TABLE_NAME = process.env.KNOWLEDGE_TABLE || "maic-knowledge";
const REGION     = process.env.AWS_REGION      || "us-east-1";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ── Knowledge Entries ──────────────────────────────────────────────────────
// Edit this array to add or update knowledge base entries.
const ENTRIES = [

  // ── Speakers ──────────────────────────────────────────────────────────────
  {
    pk:      "speaker#joe-holmes",
    type:    "speaker",
    title:   "Joe Holmes — Codecademy",
    summary: "Joe Holmes from Codecademy spoke about career paths in AI and how to build practical coding skills. Discussed Codecademy's AI-powered learning tools.",
    content: `Speaker: Joe Holmes
Company: Codecademy
Talk Title: Building a Career in AI — Practical Skills and Learning Paths

Key Points:
- The AI job market values demonstrable projects over credentials alone.
- Codecademy's AI courses focus on Python, data science, and machine learning fundamentals.
- Hands-on practice with real datasets is the fastest path to employability.
- Recommended learning order: Python basics → data manipulation (pandas/numpy) → machine learning (scikit-learn) → deep learning (TensorFlow/PyTorch).
- Highlighted Codecademy's new AI-assisted code review feature that gives contextual feedback.
- Encouraged students to build a GitHub portfolio of at least 3 completed projects before applying.
- Q&A: stressed that soft skills (communicating model outputs to non-technical stakeholders) are underrated.

Resources Mentioned:
- Codecademy Data Science career path
- Kaggle for competitions and datasets
- fast.ai for practical deep learning

Hosted by: MAIC at JMU`,
    tags: ["joe holmes", "codecademy", "career", "ai", "python", "learning", "skills", "speaker"],
  },

  {
    pk:      "speaker#yi-chen",
    type:    "speaker",
    title:   "Yi Chen — World/Orb",
    summary: "Yi Chen from World (formerly Worldcoin) discussed decentralized identity verification using AI, biometrics, and the Orb device.",
    content: `Speaker: Yi Chen
Company: World (formerly Worldcoin) / Orb
Talk Title: AI and Decentralized Identity — The World Project

Key Points:
- World project aims to create a global proof-of-personhood system using iris scanning.
- The Orb device uses AI-powered computer vision to verify human identity without storing biometric data.
- Privacy-preserving design: only a cryptographic hash (WorldID) is retained, not the iris image.
- Discussed the challenge of distinguishing humans from AI bots at scale — a growing problem.
- ZK (zero-knowledge) proofs allow identity verification without revealing personal information.
- Controversy and ethical considerations: data sovereignty, access in developing nations, centralization risks.
- Technical stack: custom AI models for iris segmentation, edge inference on the Orb hardware.

Q&A Highlights:
- How is data protected? Iris images deleted after hashing on-device.
- Could the AI be fooled? Liveness detection and anti-spoofing models are continuously updated.
- What's next? Mobile-based verification (phone camera) as an alternative to the Orb.

Hosted by: MAIC at JMU`,
    tags: ["yi chen", "world", "worldcoin", "orb", "identity", "biometrics", "iris", "zk proofs", "privacy", "speaker"],
  },

  // ── Events ─────────────────────────────────────────────────────────────────
  {
    pk:      "event#april-symposium-2025",
    type:    "event",
    title:   "MAIC Spring Symposium — April 26, 2025",
    summary: "MAIC's flagship end-of-semester event where members showcase their semester projects to faculty, students, and employers.",
    content: `Event: MAIC Spring Symposium
Date: April 26, 2025
Type: Flagship showcase event

Overview:
The Spring Symposium is MAIC's premier event of the semester. Members from all five teams present their semester-long projects in a poster/demo format open to JMU faculty, students, and external employers.

What to Expect:
- Project demos and posters from AI Engineering, AI Ethics, Robotics, Cybersecurity, and Website Development teams
- Networking with industry professionals and JMU faculty
- Recognition for outstanding projects
- Opportunity for employers to connect with student talent

Who Can Attend:
- MAIC members (required to present their team's work)
- JMU students and faculty (open attendance)
- Industry guests and employers (invited)

Tips for Attendees:
- Bring business cards or a LinkedIn QR code for networking
- Prepare a 60-second elevator pitch for your project
- Dress business-casual`,
    tags: ["symposium", "april 26", "showcase", "demo", "projects", "event", "spring", "2025", "networking"],
  },

  // ── Topics / Notes ─────────────────────────────────────────────────────────
  {
    pk:      "topic#how-to-join",
    type:    "topic",
    title:   "How to Join MAIC",
    summary: "Steps for JMU students to join MAIC: find us on BeInvolved, attend a meeting, and sign up for a team.",
    content: `How to Join MAIC

1. Find us on BeInvolved (JMU's student organization platform) and click "Join."
2. Attend a bi-weekly Tuesday meeting at 6:30 PM — check BeInvolved or our announcements for the exact room and date.
3. At your first meeting, introduce yourself to the executive board and learn about the five project teams.
4. Sign up for the team that matches your interests: AI Engineering, AI Ethics, Robotics, Cybersecurity, or Website Development.
5. You're in! Members get access to weekly workshops, the guest speaker series, and semester community projects.

Note: Membership is open to all JMU students regardless of major or experience level. No prior AI or coding knowledge required for most teams.

Contact: madisonaiclub@gmail.com`,
    tags: ["join", "membership", "how to", "beinvolved", "sign up", "teams", "new member"],
  },

  {
    pk:      "topic#ai-engineering-team",
    type:    "topic",
    title:   "AI Engineering Team",
    summary: "MAIC's AI Engineering team builds hands-on AI/ML projects, from model training to deployment. Open to all experience levels.",
    content: `Team: AI Engineering
Category: Club Project Team

Focus:
Hands-on development of AI and machine learning applications. Projects span the full ML pipeline — data collection, model training, evaluation, and deployment.

Example Projects:
- Building and fine-tuning language models
- Computer vision applications (object detection, image classification)
- AI-powered web applications and APIs
- This chatbot (MAIC's own AI assistant) was built by this team

Skills You'll Develop:
- Python, PyTorch, TensorFlow, Hugging Face
- Cloud deployment (AWS, Bedrock, Lambda)
- Data preprocessing and feature engineering
- Prompt engineering and LLM integration

Who Should Join:
Anyone interested in building real AI systems. Prior coding experience helpful but not required — pair programming with experienced members is encouraged.`,
    tags: ["ai engineering", "team", "machine learning", "ml", "python", "pytorch", "projects", "llm"],
  },
];

// ── Seeding Logic ──────────────────────────────────────────────────────────
async function clearTable() {
  console.log(`Clearing all items from ${TABLE_NAME}…`);
  const { Items = [] } = await ddb.send(new ScanCommand({ TableName: TABLE_NAME }));
  for (const item of Items) {
    await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { pk: item.pk } }));
    console.log(`  Deleted: ${item.pk}`);
  }
  console.log(`Cleared ${Items.length} items.\n`);
}

async function seedEntries() {
  console.log(`Seeding ${ENTRIES.length} entries into ${TABLE_NAME}…`);
  for (const entry of ENTRIES) {
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: entry }));
    console.log(`  Seeded: ${entry.pk}`);
  }
  console.log(`\nDone. Knowledge base is ready.`);
}

(async () => {
  const reset = process.argv.includes("--reset");
  if (reset) await clearTable();
  await seedEntries();
})().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
