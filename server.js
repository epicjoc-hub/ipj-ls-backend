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
app.use(express.json());

app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
}));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, sameSite: "lax" }
}));

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
  EDITOR_ROLE_IDS
} = process.env;

const testerRoles = TESTER_ROLE_IDS.split(",").map(r => r.trim());
const editorRoles = EDITOR_ROLE_IDS.split(",").map(r => r.trim());

function generateTesterCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

async function getGuildMember(id) {
  const res = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${id}`, {
    headers: { Authorization: "Bot " + DISCORD_BOT_TOKEN }
  });
  return res.ok ? res.json() : null;
}

app.get("/auth/discord", (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify"
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("Missing code.");

  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: DISCORD_REDIRECT_URI
    })
  });

  const token = await tokenRes.json();

  const user = await (
    await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: "Bearer " + token.access_token }
    })
  ).json();

  const member = await getGuildMember(user.id);
  const roles = member?.roles || [];

  const isTester = roles.some(r => testerRoles.includes(r));
  const isEditor = roles.some(r => editorRoles.includes(r));

  await db.read();
  let entry = Object.entries(db.data.testers).find(([code, v]) => v.userId === user.id);

  if (isTester && !entry) {
    let code;
    do { code = generateTesterCode(); }
    while (db.data.testers[code]);

    db.data.testers[code] = { userId: user.id };
    await db.write();
  }

  req.session.user = {
    id: user.id,
    tag: user.username + "#" + user.discriminator,
    isTester,
    isEditor
  };

  res.redirect(process.env.FRONTEND_URL + "/dashboard");
});

app.get("/check", async (req, res) => {
  if (!req.session.user) return res.json({ auth: false });
  return res.json({ auth: true, ...req.session.user });
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log("✅ Backend running on", PORT));
