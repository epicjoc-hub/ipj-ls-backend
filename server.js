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

// load env
dotenv.config();

// dirname fix (ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// express app
const app = express();
app.set("trust proxy", 1);
app.use(express.json());

// CORS (frontend Netlify)
app.use(
  cors({
    origin: process.env.FRONTEND_BASE_URL,
    credentials: true,
  })
);

// sessions (IMPORTANT !!!)
app.use(
  session({
    secret: process.env.SESSION_SECRET || "REPLACE_THIS",
    resave: false,
    saveUninitialized: true,
    cookie: {
      secure: true,
      sameSite: "none",
    },
  })
);

// lowdb
const file = path.join(__dirname, "db.json");
const adapter = new JSONFile(file);
const db = new Low(adapter);

async function initDB() {
  await db.read();
  db.data ||= { testers: {}, tests: {}, configs: {} };
  await db.write();
}
await initDB();

// env
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

// roles from .env
const testerRoles = (TESTER_ROLE_IDS || "")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);

const editorRoles = (EDITOR_ROLE_IDS || "")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);

// random tester code
function genTesterCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

// discord utility calls
async function getUserInfo(access_token) {
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!res.ok) return null;
  return await res.json();
}

async function getGuildMember(id) {
  const res = await fetch(
    `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${id}`,
    { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
  );
  if (!res.ok) return null;
  return await res.json();
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
  const isTester = roles.some((r) => testerRoles.includes(r));
  const isEditor = roles.some((r) => editorRoles.includes(r));

  // generate tester code if needed
  await db.read();
  let entry = Object.entries(db.data.testers).find(
    ([, v]) => v.userId === user.id
  );

  if (isTester && !entry) {
    let code;
    do code = genTesterCode();
    while (db.data.testers[code]);

    db.data.testers[code] = {
      userId: user.id,
      createdAt: new Date().toISOString(),
    };
    await db.write();
  }

  req.session.user = {
    id: user.id,
    discord_tag: `${user.username}#${user.discriminator}`,
    isTester,
    isEditor,
  };

  return res.redirect(`${FRONTEND_BASE_URL}/dashboard`);
});

/* =======================
   SESSION CHECK
======================= */

app.get("/check-tester", (req, res) => {
  const u = req.session.user;
  if (!u) return res.json({ authenticated: false });

  return res.json({
    authenticated: true,
    discord_tag: u.discord_tag,
    isTester: u.isTester,
    isEditor: u.isEditor,
  });
});

/* =======================
   TESTER CODE
======================= */

app.get("/tester-code", async (req, res) => {
  const u = req.session.user;
  if (!u) return res.json({ code: null });

  await db.read();
  const entry = Object.entries(db.data.testers).find(
    ([, v]) => v.userId === u.id
  );

  return res.json({
    code: entry ? entry[0] : null,
  });
});

/* =======================
   SUBMIT TEST
======================= */

app.post("/submit-test", async (req, res) => {
  const { testerCode, testType, result, details } = req.body;

  await db.read();
  const entry = db.data.testers[testerCode];
  if (!entry) return res.json({ error: "Cod candidat invalid" });

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

  // send embed to Discord channel
  if (REPORT_CHANNEL_ID) {
    try {
      const embed = {
        title: "Raport Test",
        color: result === "ADMIS" ? 5763719 : 15548997,
        fields: [
          { name: "Rezultat", value: result },
          { name: "Tip", value: testType },
          { name: "Detalii", value: details || "—" },
        ],
        footer: { text: `UserID: ${userId}` },
        timestamp: new Date().toISOString(),
      };

      await fetch(
        `https://discord.com/api/v10/channels/${REPORT_CHANNEL_ID}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ embeds: [embed] }),
        }
      );
    } catch (e) {
      console.log("Discord embed error:", e);
    }
  }

  res.json({ ok: true });
});

/* =======================
   ADMIN CONFIG (editor only)
======================= */

async function requireEditor(req, res, next) {
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: "Not auth" });

  const member = await getGuildMember(u.id);
  const roles = member?.roles || [];

  if (!roles.some((r) => editorRoles.includes(r)))
    return res.status(403).json({ error: "Forbidden" });

  next();
}

app.post("/manage-tests/config", requireEditor, async (req, res) => {
  const { testName, timeLimitSeconds, questionsCount, maxMistakes } = req.body;

  await db.read();
  db.data.configs[testName] = {
    testName,
    timeLimitSeconds,
    questionsCount,
    maxMistakes,
  };
  await db.write();

  res.json({ ok: true, config: db.data.configs[testName] });
});

/* =======================
   CONFIG GET
======================= */

app.get("/config/:name", async (req, res) => {
  await db.read();
  return res.json(db.data.configs[req.params.name] || {});
});

/* =======================
   HISTORY
======================= */

app.get("/tests/history", async (req, res) => {
  await db.read();
  const tests = Object.values(db.data.tests).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json({ tests });
});

/* =======================
   STATS
======================= */

app.get("/tests/stats", async (req, res) => {
  await db.read();
  const tests = Object.values(db.data.tests);

  const byType = {};
  const byResult = { ADMIS: 0, RESPINS: 0 };
  const byDay = {};

  tests.forEach((t) => {
    // tip
    byType[t.testType] = (byType[t.testType] || 0) + 1;

    // rezultat
    byResult[t.result]++;

    // pe zile
    const day = t.createdAt.split("T")[0];
    byDay[day] = (byDay[day] || 0) + 1;
  });

  res.json({ byType, byResult, byDay });
});

/* =======================
   LOGOUT
======================= */

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect(FRONTEND_BASE_URL || "/");
  });
});

/* =======================
   HOME
======================= */

app.get("/", (req, res) => {
  res.send("✅ Backend online & ready");
});

/* =======================
   START SERVER
======================= */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`✅ Backend running on port ${PORT}`)
);
