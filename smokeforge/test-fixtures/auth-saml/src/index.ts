import express from "express";
import passport from "passport";
import { Strategy as SamlStrategy } from "passport-saml";

const app = express();

passport.use(new SamlStrategy(
  {
    path: "/auth/saml/callback",
    entryPoint: process.env.SAML_ENTRY_POINT!,
    issuer: "my-app",
    cert: process.env.SAML_CERT!,
  },
  (profile: any, done: any) => done(null, profile)
));

// Public health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Initiate SAML SSO login
app.get("/auth/saml", passport.authenticate("saml"));

// SAML callback
app.post("/auth/saml/callback", passport.authenticate("saml"), (req, res) => {
  res.redirect("/dashboard");
});

// Protected route
app.get("/dashboard", (req, res) => {
  if (!req.user) return res.redirect("/auth/saml");
  res.json({ page: "dashboard", user: req.user });
});

app.get("/api/profile", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  res.json({ user: req.user });
});

app.listen(3000);
