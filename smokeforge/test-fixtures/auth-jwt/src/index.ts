import express from "express";
import jwt from "jsonwebtoken";

const app = express();
app.use(express.json());

const SECRET = process.env.JWT_SECRET || "dev-secret";

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (email === "admin@example.com" && password === "password123") {
    const token = jwt.sign({ sub: "1", email }, SECRET, { expiresIn: "1h" });
    return res.json({ token });
  }
  res.status(401).json({ error: "Invalid credentials" });
});

function requireAuth(req: any, res: any, next: any) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = jwt.verify(auth.slice(7), SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

app.get("/api/users/me", requireAuth, (req: any, res) => res.json({ user: req.user }));
app.get("/api/dashboard", requireAuth, (_req, res) => res.json({ page: "dashboard" }));
app.get("/api/items", requireAuth, (_req, res) => res.json({ items: [] }));

app.listen(3000);
