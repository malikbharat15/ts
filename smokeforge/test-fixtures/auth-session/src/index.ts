import express from "express";
import session from "express-session";

const app = express();
app.use(express.json());
app.use(session({ secret: "keyboard cat", resave: false, saveUninitialized: false }));

const USERS: Record<string, string> = { "admin@example.com": "password123" };

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/auth/login", (req: any, res) => {
  const { email, password } = req.body;
  if (USERS[email] === password) {
    req.session.user = { email };
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Invalid credentials" });
});

app.post("/api/auth/logout", (req: any, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/profile", (req: any, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
  res.json({ user: req.session.user });
});

app.get("/api/dashboard", (req: any, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
  res.json({ page: "dashboard", user: req.session.user });
});

app.listen(3000);
