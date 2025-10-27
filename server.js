// server.js
import express from "express";
import session from "express-session";
import fetch from "node-fetch";
import cors from "cors";
import crypto from "crypto";
import dotenv from "dotenv";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(
  cors({
    origin: process.env.FRONTEND_BASE_URL,
    credentials: true,
  })
);

app.use(
  session({
    secret: process.env.SESSION_SECRET || "REPLACE_THIS",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: true, sameSite: "none" },
  })
);

// lowdb
const file = path.join(__dirname, "db.json");
const adapter = new JSONFile(file);
const db = new Low(adapter);
await db.read();
db.data ||= { testers: {}, tests: {}, configs: {}, duty: {}, pings: [] };
await db.write();

// ENV
const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_BOT_TOKEN,
  GUILD_ID,
  TESTER_ROLE_IDS,
  EDITOR_ROLE_IDS,
  REPORT_CHANNEL_ID,
  FRONTEND_BASE_URL,
} = process.env;

// roles
const testerRoles = (TESTER_ROLE_IDS || "").split(",").map(s=>s.trim()).filter(Boolean);
const editorRoles = (EDITOR_ROLE_IDS || "").split(",").map(s=>s.trim()).filter(Boolean);

// special roles (cerute)
const RADIO_INSTR_ROLE = "1280907729950736427";
const MDT_INSTR_ROLE   = "1280907912876916830";
const TESTER_ROLE_ANY  = "1163218630620749834"; // tester general

// helpers
async function discordGET(url, headers={}) {
  const r = await fetch(url, { headers });
  if (!r.ok) return null;
  return await r.json();
}
async function getUserInfo(access_token) {
  return await discordGET("https://discord.com/api/v10/users/@me", {
    Authorization: `Bearer ${access_token}`,
  });
}
async function getGuildMember(id) {
  return await discordGET(
    `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${id}`,
    { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
  );
}

/* =======================
   AUTH
======================= */
app.get("/auth/discord", (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify guilds.members.read",
    prompt: "consent",
  }).toString();
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send("Missing code");

  const tokenRes = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: DISCORD_REDIRECT_URI,
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return res.send("OAuth failed");

  const user = await getUserInfo(tokenData.access_token);
  const member = await getGuildMember(user.id);
  const roles = member?.roles || [];

  const isTester = roles.some((r) => testerRoles.includes(r) || r === TESTER_ROLE_ANY);
  const isEditor = roles.some((r) => editorRoles.includes(r));
  const canRadio = roles.includes(RADIO_INSTR_ROLE);
  const canMDT   = roles.includes(MDT_INSTR_ROLE);

  req.session.user = {
    id: user.id,
    discord_tag: `${user.username}#${user.discriminator}`,
    isTester,
    isEditor,
    canRadio,
    canMDT,
  };

  return res.redirect(`${FRONTEND_BASE_URL}/dashboard`);
});

/* =======================
   SESSION
======================= */
app.get("/check-tester", (req, res) => {
  const u = req.session.user;
  if (!u) return res.json({ authenticated: false });
  return res.json({
    authenticated: true,
    discord_tag: u.discord_tag,
    isTester: u.isTester,
    isEditor: u.isEditor,
    canRadio: u.canRadio,
    canMDT: u.canMDT,
  });
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect(FRONTEND_BASE_URL || "/");
  });
});

/* =======================
   CONFIG (editor)
======================= */
async function requireEditor(req, res, next) {
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: "Not auth" });

  // verifică live rolurile
  const member = await getGuildMember(u.id);
  const roles = member?.roles || [];
  if (!roles.some((r) => editorRoles.includes(r)))
    return res.status(403).json({ error: "Forbidden" });

  next();
}

app.get("/config/:name", async (req, res) => {
  await db.read();
  return res.json(db.data.configs[req.params.name] || {});
});
app.get("/config", async (req, res) => {
  await db.read();
  return res.json(db.data.configs);
});
app.post("/manage-tests/config", requireEditor, async (req, res) => {
  const { testName, timeLimitSeconds, questionsCount, maxMistakes } = req.body;
  await db.read();
  db.data.configs[testName] = { testName, timeLimitSeconds, questionsCount, maxMistakes };
  await db.write();
  res.json({ ok: true, config: db.data.configs[testName] });
});
app.delete("/manage-tests/config/:name", requireEditor, async (req, res) => {
  await db.read();
  delete db.data.configs[req.params.name];
  await db.write();
  return res.json({ ok: true });
});

/* =======================
   TESTS DATA
======================= */
app.get("/tests/history", async (req, res) => {
  await db.read();
  const tests = Object.values(db.data.tests).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json({ tests });
});
app.get("/tests/stats", async (req, res) => {
  await db.read();
  const tests = Object.values(db.data.tests);
  const byType = {};
  const byResult = { ADMIS: 0, RESPINS: 0 };
  const byDay = {};
  tests.forEach((t) => {
    byType[t.testType] = (byType[t.testType] || 0) + 1;
    byResult[t.result]++;
    const day = t.createdAt.split("T")[0];
    byDay[day] = (byDay[day] || 0) + 1;
  });
  res.json({ byType, byResult, byDay });
});

/* =======================
   DUTY
======================= */
// user intră on duty cu roluri (["radio", "mdt", "general"])
app.post("/duty/on", (req, res) => {
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: "Not auth" });

  const roles = Array.isArray(req.body.roles) ? req.body.roles : [];
  db.data.duty[u.id] = {
    id: u.id,
    tag: u.discord_tag,
    roles: [
      ...(u.canRadio ? ["radio"] : []),
      ...(u.canMDT ? ["mdt"] : []),
      ...(u.isTester ? ["general"] : []),
      ...roles.filter((x) => ["radio", "mdt", "general"].includes(x)),
    ],
    since: new Date().toISOString(),
  };
  db.write();
  broadcast({ type: "duty-update", payload: db.data.duty });
  res.json({ ok: true });
});

app.post("/duty/off", (req, res) => {
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: "Not auth" });
  delete db.data.duty[u.id];
  db.write();
  broadcast({ type: "duty-update", payload: db.data.duty });
  res.json({ ok: true });
});

app.get("/duty/list", async (req, res) => {
  await db.read();
  return res.json(db.data.duty);
});

// verificare dacă există instructor pentru un test
app.get("/duty/allow/:type", async (req, res) => {
  const type = String(req.params.type || "").toLowerCase();
  await db.read();
  const duty = Object.values(db.data.duty);
  const allowed =
    type === "radio"
      ? duty.some((u) => u.roles.includes("radio"))
      : type === "mdt"
      ? duty.some((u) => u.roles.includes("mdt"))
      : false;
  res.json({ allowed, duty });
});

/* =======================
   LIVE PINGS (SSE)
======================= */
const sseClients = new Set(); // { res, userId }
function broadcast(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const client of sseClients) {
    client.res.write(data);
  }
}

// subscribe la evenimente (instructori/privesc pings + duty update)
app.get("/events", (req, res) => {
  const u = req.session.user;
  if (!u) return res.status(401).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ type: "hello", payload: { now: Date.now() } })}\n\n`);

  const client = { res, userId: u.id };
  sseClients.add(client);

  req.on("close", () => {
    sseClients.delete(client);
    res.end();
  });
});

// candidat/agent solicită instructor pt test
app.post("/call-instructor", async (req, res) => {
  const { testType, note } = req.body || {};
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: "Not auth" });

  const id = crypto.randomBytes(6).toString("hex");
  const ping = {
    id,
    testType: (testType || "").toLowerCase(), // "radio" | "mdt"
    note: note || "",
    requester: { id: u.id, tag: u.discord_tag },
    time: new Date().toISOString(),
    status: "open",
  };

  await db.read();
  db.data.pings.push(ping);
  await db.write();

  broadcast({ type: "ping", payload: ping });
  res.json({ ok: true, id });
});

// instructor acceptă
app.post("/ack-ping", async (req, res) => {
  const { id } = req.body || {};
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: "Not auth" });

  await db.read();
  const ping = db.data.pings.find((p) => p.id === id);
  if (!ping) return res.status(404).json({ error: "Not found" });

  // verifică rolul instructorului
  if (ping.testType === "radio" && !u.canRadio)
    return res.status(403).json({ error: "Nu ai rol de Instructor Radio" });
  if (ping.testType === "mdt" && !u.canMDT)
    return res.status(403).json({ error: "Nu ai rol de Instructor MDT" });

  ping.status = "accepted";
  ping.acceptedBy = { id: u.id, tag: u.discord_tag };
  await db.write();

  broadcast({ type: "ack", payload: ping });
  res.json({ ok: true });
});

/* =======================
   ROOT
======================= */
app.get("/", (req, res) => {
  res.send("✅ Backend online & live events ready");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("✅ Backend running on", PORT));
