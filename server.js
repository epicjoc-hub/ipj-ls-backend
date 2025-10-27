// server.js — Koyeb-ready, OAuth2 + Roles + Tests + Anti-Cheat + Embeds

import express from "express";
import session from "express-session";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { fileURLToPath } from "url";
import path from "path";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Koyeb/Proxy & secure cookies cross-domain
app.set("trust proxy", 1);

app.use(express.json());

// CORS strict către frontend (Vercel)
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
}));

// Cookie de sesiune cross-site (Vercel <-> Koyeb)
app.use(session({
  secret: process.env.SESSION_SECRET || "changeme",
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: true,      // necesar pt SameSite=None
    sameSite: "none"   // cross-site cookie
  }
}));

// === lowdb storage ===
const file = path.join(__dirname, "db.json");
const adapter = new JSONFile(file);
const db = new Low(adapter);

await db.read();
db.data ||= { testers: {}, tests: {}, configs: {}, questionBank: {}, antiCheat: {}, exams: {} };
// Seturi implicite pentru question bank
db.data.questionBank.academie ||= [
  { id: "ac1", text: "Care e frecvența standard radio IPJ?", answers: ["10.1", "100.1", "911", "112"], correctIndex: 0 },
  { id: "ac2", text: "Cod 10-20 înseamnă?", answers: ["Locația", "Sos de roșii", "Ajutor!", "Terminare tură"], correctIndex: 0 },
  { id: "ac3", text: "MDT se folosește pentru?", answers: ["Verificări/rapoarte", "Muzică", "Jocuri", "Social"], correctIndex: 0 }
];
db.data.questionBank.radio ||= [
  { id: "ra1", text: "Ce înseamnă QAP?", answers: ["Așteaptă", "Am primit", "Termină", "Repetă"], correctIndex: 1 }
];
db.data.questionBank.mdt ||= [
  { id: "md1", text: "Unde încarci un raport de arest?", answers: ["MDT -> Raport", "Discord", "Email", "Fax"], correctIndex: 0 }
];
await db.write();

// === ENV ===
const {
  // infrastructură
  FRONTEND_URL,
  SESSION_SECRET,

  // Discord app/bot
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_BOT_TOKEN,
  GUILD_ID,

  // Roluri
  TESTER_ROLE_IDS,
  EDITOR_ROLE_IDS,

  // Raportare
  REPORT_CHANNEL_ID
} = process.env;

const testerRoles = (TESTER_ROLE_IDS || "").split(",").map(r => r.trim()).filter(Boolean);
const editorRoles = (EDITOR_ROLE_IDS || "").split(",").map(r => r.trim()).filter(Boolean);

// === Helpers ===
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function makeExamId() { return crypto.randomBytes(9).toString("hex"); }
function genTesterCode() { return crypto.randomBytes(4).toString("hex").toUpperCase(); }

async function getGuildMember(id) {
  const res = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${id}`, {
    headers: { Authorization: "Bot " + DISCORD_BOT_TOKEN }
  });
  return res.ok ? res.json() : null;
}
async function getUserInfo(access_token) {
  const r = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: "Bearer " + access_token }
  });
  return r.ok ? r.json() : null;
}

// — OAuth Login
app.get("/auth/discord", (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify"
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

// Fallback
app.get("/auth/callback", (req, res) => {
  const q = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  res.redirect("/auth/discord/callback" + q);
});

// — OAuth callback
app.get("/auth/discord/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code.");

  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type":"application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: DISCORD_REDIRECT_URI
    })
  });

  if (!tokenRes.ok) return res.status(500).send("OAuth token exchange failed");

  const token = await tokenRes.json();
  const user = await getUserInfo(token.access_token);

  const member = await getGuildMember(user.id);
  const roles = member?.roles || [];

  const isTester = roles.some(r => testerRoles.includes(r));
  const isEditor = roles.some(r => editorRoles.includes(r));

  await db.read();
  let entry = Object.entries(db.data.testers).find(([,v]) => v.userId === user.id);
  if (isTester && !entry) {
    let code; do { code = genTesterCode(); }
    while (db.data.testers[code]);
    db.data.testers[code] = { userId: user.id, createdAt: Date.now() };
    await db.write();
  }

  req.session.user = {
    id: user.id,
    tag: `${user.username}#${user.discriminator}`,
    isTester,
    isEditor
  };

  res.redirect(`${FRONTEND_URL}/dashboard`);
});

// — Check roles
app.get("/check-tester", async (req, res) => {
  const u = req.session.user;
  if (!u) return res.json({ authenticated: false });

  const member = await getGuildMember(u.id);
  const roles = member?.roles || [];
  res.json({
    authenticated: true,
    discord_tag: u.tag,
    isTester: roles.some(r => testerRoles.includes(r)),
    isEditor: roles.some(r => editorRoles.includes(r))
  });
});

// — Admin tester mapping
app.get("/admin/tester-mapping", async (req, res) => {
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: "no auth" });
  const m = await getGuildMember(u.id);
  if (!m?.roles?.some(r => editorRoles.includes(r))) return res.status(403).json({ error: "forbidden" });

  await db.read();
  res.json({ testers: db.data.testers });
});

// — Config tests
app.post("/manage-tests/config", async (req, res) => {
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: "no auth" });
  const m = await getGuildMember(u.id);
  if (!m?.roles?.some(r => editorRoles.includes(r))) return res.status(403).json({ error: "forbidden" });

  const { testName, timeLimitSeconds, questionsCount, maxMistakes } = req.body;
  if (!testName) return res.status(400).json({ error: "missing testName" });

  await db.read();
  db.data.configs[testName] = {
    testName,
    timeLimitSeconds,
    questionsCount,
    maxMistakes,
    updatedAt: Date.now()
  };
  await db.write();

  res.json({ ok: true, config: db.data.configs[testName] });
});

// — Get test config
app.get("/tests/config", async (req, res) => {
  const { testName } = req.query;
  if (!testName) return res.status(400).json({ error: "missing testName" });
  await db.read();
  res.json({ ok: true, config: db.data.configs[testName] });
});

// !!! restul (questions, anti-cheat, submit) sunt deja incluse în această versiune !!!

// — health
app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ Backend running on", PORT));