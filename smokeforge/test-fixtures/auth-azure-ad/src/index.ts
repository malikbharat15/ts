import express from "express";
import passport from "passport";
import { OIDCStrategy } from "passport-azure-ad";

const app = express();

passport.use(new OIDCStrategy(
  {
    identityMetadata: `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID}/v2.0/.well-known/openid-configuration`,
    clientID: process.env.AZURE_AD_CLIENT_ID!,
    clientSecret: process.env.AZURE_AD_CLIENT_SECRET!,
    responseType: "code",
    responseMode: "query",
    redirectUrl: process.env.AZURE_AD_REDIRECT_URL!,
    allowHttpForRedirectUrl: true,
    validateIssuer: false,
    passReqToCallback: false,
    scope: ["profile", "email"],
  },
  (iss: any, sub: any, profile: any, done: any) => done(null, profile)
));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Initiate Azure AD OIDC login
app.get("/auth/openid", passport.authenticate("azuread-openidconnect"));

// Azure AD callback
app.get("/auth/openid/return",
  passport.authenticate("azuread-openidconnect", { failureRedirect: "/" }),
  (_req, res) => res.redirect("/dashboard")
);

app.get("/dashboard", (req, res) => {
  if (!req.user) return res.redirect("/auth/openid");
  res.json({ page: "dashboard" });
});

app.get("/api/users/me", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  res.json({ user: req.user });
});

app.listen(3000);
