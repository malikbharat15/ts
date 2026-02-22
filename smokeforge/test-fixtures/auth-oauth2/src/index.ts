import express from "express";import express from "express";



































app.listen(3000);app.get("/api/items", (_req, res) => res.json({ items: [] }));});  res.json({ page: "dashboard" });  if (!req.user) return res.redirect("/auth/google");app.get("/dashboard", (req, res) => {);  (_req, res) => res.redirect("/dashboard")  passport.authenticate("oauth2", { failureRedirect: "/" }),app.get("/auth/google/callback",app.get("/auth/google", passport.authenticate("oauth2"));app.get("/health", (_req, res) => res.json({ status: "ok" }));));    done(null, { accessToken, profile })  (accessToken: string, refreshToken: string, profile: any, done: any) =>  },    callbackURL: "http://localhost:3000/auth/google/callback",    clientSecret: process.env.OAUTH2_CLIENT_SECRET!,    clientID: process.env.OAUTH2_CLIENT_ID!,    tokenURL: "https://example.com/oauth2/token",    authorizationURL: "https://example.com/oauth2/authorize",  {passport.use(new OAuth2Strategy(const app = express();import OAuth2Strategy from "passport-oauth2";import passport from "passport";import passport from "passport";
import OAuth2Strategy from "passport-oauth2";

const app = express();

passport.use(new OAuth2Strategy(
  {
    authorizationURL: "https://provider.example.com/oauth2/authorize",
    tokenURL: "https://provider.example.com/oauth2/token",
    clientID: process.env.OAUTH2_CLIENT_ID!,
    clientSecret: process.env.OAUTH2_CLIENT_SECRET!,
    callbackURL: "http://localhost:3000/auth/google/callback",
  },
  (accessToken: string, _refreshToken: string, _profile: any, done: any) =>
    done(null, { accessToken })
));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Initiate OAuth2 flow
app.get("/auth/google", passport.authenticate("oauth2"));

// OAuth2 callback – filename "auth.google.callback" triggers SSO filename detection
app.get("/auth/google/callback",
  passport.authenticate("oauth2", { failureRedirect: "/" }),
  (_req, res) => res.redirect("/dashboard")
);

app.get("/dashboard", (req, res) => {
  if (!req.user) return res.redirect("/auth/google");
  res.json({ page: "dashboard" });
});

app.get("/api/feed", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  res.json({ items: [] });
});

app.listen(3000);
