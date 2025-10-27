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
app.use(cors({ origin: process.env.FRONTEND_BASE_URL, credentials: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
      secure: true,
      sameSite: "lax",
    },
  })
);

const file = path.join(__dirname, "db.json");
const adapter = new JSONFile(file);
const db = new Low(adapter);

await db.read();
db.data ||= { testers: {}, tests: {}, configs: {} };
await db.write();

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

const testerRoles = TESTER_ROLE_IDS.split(",");
const editorRoles = EDITOR_ROLE_IDS.split(",");

function genTesterCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

async function getUserInfo(access_token) {
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  return res.ok ? await res.json() : null;
}

async function getGuildMember(id) {
  const res = await fetch(
    `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${id}`,
    { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
  );
  return res.ok ? await res.json() : null;
}

/* LOGIN */
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

/* CALLBACK */
app.get("/auth/discord/callback", async (req, res) => {
  const code = req.query.code;
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

  await db.read();
  let entry = Object.entries(db.data.testers).find(
    ([, v]) => v.userId === user.id
  );

  if (isTester && !entry) {
    let code;
    do {
      code = genTesterCode();
    } while (db.data.testers[code]);

    db.data.testers[code] = {
      userId: user.id,
      createdAt: new Date().toISOString(),
    };
    await db.write();
  }

  req.session.user = {
    id: user.id,
    username: `${user.username}#${user.discriminator}`,
    isTester,
    isEditor,
  };

  return res.redirect(`${FRONTEND_BASE_URL}/dashboard`);
});

/* SESSION CHECK */
app.get("/check-tester", (req, res) => {
  const u = req.session.user;
  if (!u) return res.json({ authenticated: false });
  return res.json({ authenticated: true, discord: u.username });
});

/* ROOT */
app.get("/", (req, res) => {
  res.send("✅ Backend Online");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`✅ Backend running on port ${PORT}`)
);
