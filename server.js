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

//=========================
// DB (lowdb)
//=========================
const file = path.join(__dirname, "db.json");
const adapter = new JSONFile(file);
const db = new Low(adapter);
await db.read();
db.data ||= { testers: {}, tests: {}, configs: {}, duty: {}, pings: [] };
await db.write();

//=========================
// ENV variables
//=========================
const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_BOT_TOKEN,
  GUILD_ID,
  FRONTEND_BASE_URL,
  REPORT_CHANNEL_ID,
  INSTRUCTOR_RADIO,
  INSTRUCTOR_MDT,
  TESTER_GENERAL,
  TESTER_ROLE_IDS,
  EDITOR_ROLE_IDS,
} = process.env;

// role arrays
const testerRoles = (TESTER_ROLE_IDS || "").split(",").map((s) => s.trim());
const editorRoles = (EDITOR_ROLE_IDS || "").split(",").map((s) => s.trim());

// special single roles
const RADIO_INSTR_ROLE = INSTRUCTOR_RADIO;
const MDT_INSTR_ROLE = INSTRUCTOR_MDT;
const TESTER_ROLE_ANY = TESTER_GENERAL;

//=========================
// Helpers Discord API
//=========================
async function getUserInfo(token) {
  const r = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return r.ok ? r.json() : null;
}

async function getGuildMember(id) {
  const r = await fetch(
    `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${id}`,
    { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
  );
  return r.ok ? r.json() : null;
}

//=========================
// AUTH
//=========================
app.get("/auth/discord", (req, res) => {
  const p = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify guilds.members.read",
    prompt: "consent",
  });
  res.redirect(`https://discord.com/oauth2/authorize?${p}`);
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
  const canMDT = roles.includes(MDT_INSTR_ROLE);

  req.session.user = {
    id: user.id,
    discord_tag: `${user.username}#${user.discriminator}`,
    isTester,
    isEditor,
    canRadio,
    canMDT,
  };

  //=== COD TESTER LOGIC
  await db.read();
  let entry = Object.entries(db.data.testers).find(([, v]) => v.userId === user.id);
  if (isTester && !entry) {
    let code;
    do code = crypto.randomBytes(3).toString("hex").toUpperCase();
    while (db.data.testers[code]);
    db.data.testers[code] = { userId: user.id, createdAt: new Date().toISOString() };
    await db.write();
  }

  return res.redirect(`${FRONTEND_BASE_URL}/dashboard`);
});

//=========================
// Session check
//=========================
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

// tester code fetch
app.get("/tester-code", async (req, res) => {
  const u = req.session.user;
  if (!u) return res.json({ code: null });

  await db.read();
  const entry = Object.entries(db.data.testers).find(([_, v]) => v.userId === u.id);
  return res.json({ code: entry ? entry[0] : null });
});

//=========================
// REQUIRE EDITOR
//=========================
async function requireEditor(req, res, next) {
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: "Not auth" });

  const member = await getGuildMember(u.id);
  const roles = member?.roles || [];
  if (!roles.some((r) => editorRoles.includes(r)))
    return res.status(403).json({ error: "Forbidden" });
  next();
}

//=========================
// Test config admin
//=========================
app.get("/config/:name", async (req, res) => {
  await db.read();
  res.json(db.data.configs[req.params.name] || {});
});

app.get("/config", async (req, res) => {
  await db.read();
  res.json(db.data.configs);
});

app.post("/manage-tests/config", requireEditor, async (req, res) => {
  const { testName, timeLimitSeconds, questionsCount, maxMistakes } = req.body;
  await db.read();
  db.data.configs[testName] = { testName, timeLimitSeconds, questionsCount, maxMistakes };
  await db.write();
  res.json({ ok: true });
});

app.delete("/manage-tests/config/:name", requireEditor, async (req, res) => {
  await db.read();
  delete db.data.configs[req.params.name];
  await db.write();
  res.json({ ok: true });
});

//=========================
// Tests history & stats
//=========================
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

//=========================
// DUTY LIVE SYSTEM
//=========================
const sseClients = new Set();
function broadcast(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const c of sseClients) c.res.write(data);
}

app.post("/duty/on", (req, res) => {
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: "Not auth" });

  db.data.duty[u.id] = {
    id: u.id,
    tag: u.discord_tag,
    roles: [
      ...(u.canRadio ? ["radio"] : []),
      ...(u.canMDT ? ["mdt"] : []),
      ...(u.isTester ? ["general"] : []),
      ...(u.isEditor ? ["general"] : []),
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
  res.json(db.data.duty);
});

// test requirements based on duty
app.get("/duty/allow/:type", async (req, res) => {
  const type = String(req.params.type).toLowerCase();
  await db.read();
  const duty = Object.values(db.data.duty);

  if (type === "academie") {
    return res.json({
      allowed: duty.some((u) => u.roles.includes("general")),
      duty,
    });
  }
  if (type === "radio") {
    return res.json({
      allowed: duty.some((u) => u.roles.includes("radio")),
      duty,
    });
  }
  if (type === "mdt") {
    return res.json({
      allowed: duty.some((u) => u.roles.includes("mdt")),
      duty,
    });
  }

  res.json({ allowed: false });
});

//=========================
// SSE subscribe
//=========================
app.get("/events", (req, res) => {
  const u = req.session.user;
  if (!u) return res.status(401).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);

  const client = { res, id: u.id };
  sseClients.add(client);
  req.on("close", () => sseClients.delete(client));
});

//=========================
// CALL instructor
//=========================
app.post("/call-instructor", async (req, res) => {
  const { testType, note } = req.body;
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: "Not auth" });

  const id = crypto.randomBytes(6).toString("hex");
  const ping = {
    id,
    testType,
    note,
    requester: { id: u.id, tag: u.discord_tag },
    time: new Date().toISOString(),
    status: "open",
  };

  await db.read();
  db.data.pings.push(ping);
  await db.write();

  //==== send embed to Discord channel
  if (REPORT_CHANNEL_ID) {
    let roleToPing = "";
    if (testType === "radio") roleToPing = `<@&${INSTRUCTOR_RADIO}>`;
    if (testType === "mdt") roleToPing = `<@&${INSTRUCTOR_MDT}>`;
    if (testType === "academie") roleToPing = `<@&${TESTER_GENERAL}>`;

    const embed = {
      title: "Call Instructor",
      color: 16753920,
      fields: [
        { name: "Solicitant", value: ping.requester.tag },
        { name: "Test", value: testType },
        { name: "Notă", value: note || "—" },
        { name: "ID Ping", value: id },
      ],
      timestamp: ping.time,
    };

    await fetch(`https://discord.com/api/v10/channels/${REPORT_CHANNEL_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: `${roleToPing} instructor necesar!`,
        embeds: [embed],
      }),
    });
  }

  broadcast({ type: "ping", payload: ping });
  res.json({ ok: true, id });
});

// accepted ping
app.post("/ack-ping", async (req, res) => {
  const { id } = req.body;
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: "Not auth" });

  await db.read();
  const ping = db.data.pings.find((p) => p.id === id);
  if (!ping) return res.status(404).json({ error: "Not found" });

  // role checks
  if (ping.testType === "radio" && !u.canRadio)
    return res.status(403).json({ error: "Nu ai rol Radio" });
  if (ping.testType === "mdt" && !u.canMDT)
    return res.status(403).json({ error: "Nu ai rol MDT" });
  if (ping.testType === "academie" && !(u.isTester || u.isEditor))
    return res.status(403).json({ error: "Nu ai rol Academie" });

  ping.status = "accepted";
  ping.acceptedBy = { id: u.id, tag: u.discord_tag };

  await db.write();

  broadcast({ type: "ack", payload: ping });
  res.json({ ok: true });
});

//=========================
// SUBMIT TEST (raport final)
//=========================
app.post("/submit-test", async (req, res) => {
  const { testerCode, testType, result, details } = req.body;
  await db.read();
  const entry = db.data.testers[testerCode];
  if (!entry) return res.json({ error: "Cod invalid" });

  const userId = entry.userId;
  const id = crypto.randomBytes(6).toString("hex");
  db.data.tests[id] = {
    id,
    testerCode,
    userId,
    testType,
    result,
    details,
    createdAt: new Date().toISOString(),
  };
  await db.write();

  res.json({ ok: true });
});

//=========================
// LOGOUT
//=========================
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect(FRONTEND_BASE_URL || "/");
  });
});

//=========================
app.get("/", (req, res) => {
  res.send("✅ Backend LIVE");
});

//=========================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("✅ Backend running on", PORT));
