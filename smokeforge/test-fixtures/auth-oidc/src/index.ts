import express from "express";
import { Issuer, generators } from "openid-client";

const app = express();

// OIDC discovery and client setup (Okta / Auth0 / Keycloak / any OIDC provider)
async function bootstrap() {
  const issuer = await Issuer.discover(
    process.env.OIDC_ISSUER_URL || "https://accounts.example.org"
  );
  const client = new issuer.Client({
    client_id: process.env.OIDC_CLIENT_ID!,
    client_secret: process.env.OIDC_CLIENT_SECRET!,
    redirect_uris: ["http://localhost:3000/auth/callback"],
    response_types: ["code"],
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.get("/auth/login", (req, res) => {
    const nonce = generators.nonce();
    const state = generators.state();
    const url = client.authorizationUrl({ scope: "openid email profile", nonce, state });
    res.redirect(url);
  });

  app.get("/auth/callback", async (req, res) => {
    try {
      const params = client.callbackParams(req);
      const tokenSet = await client.callback("http://localhost:3000/auth/callback", params);
      (req.session as any).user = tokenSet.claims();
      res.redirect("/dashboard");
    } catch {
      res.redirect("/auth/login");
    }
  });

  app.get("/dashboard", (req, res) => {
    if (!(req.session as any).user) return res.redirect("/auth/login");
    res.json({ page: "dashboard" });
  });

  app.get("/api/me", (req, res) => {
    if (!(req.session as any).user) return res.status(401).json({ error: "Unauthorized" });
    res.json({ user: (req.session as any).user });
  });

  app.listen(3000);
}

bootstrap();
