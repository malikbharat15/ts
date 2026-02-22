import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import simpleGit from "simple-git";
import { spinner } from "../utils/logger";

export interface CloneResult {
  repoPath: string;
  repoName: string;
  cleanup: () => Promise<void>;
}

function extractRepoName(repoUrl: string): string {
  // Handle: https://github.com/acme/myapp or https://github.com/acme/myapp.git
  const cleaned = repoUrl.replace(/\.git$/, "").replace(/\/$/, "");
  const parts = cleaned.split("/");
  const owner = parts[parts.length - 2] ?? "unknown";
  const repo = parts[parts.length - 1] ?? "unknown";
  return `${owner}/${repo}`;
}

function buildTargetDir(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return path.join(os.tmpdir(), `smokeforge-${timestamp}-${random}`);
}

async function removeDir(dirPath: string): Promise<void> {
  try {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  } catch {
    // ignore errors during cleanup
  }
}

function isLocalPath(repoUrl: string): boolean {
  return (
    repoUrl.startsWith("/") ||
    repoUrl.startsWith("./") ||
    repoUrl.startsWith("../") ||
    repoUrl === "." ||
    repoUrl === ".."
  );
}

export async function cloneRepo(
  repoUrl: string,
  targetDir?: string
): Promise<CloneResult> {
  // ── Local path: skip cloning, use the directory directly ──────────────────
  if (isLocalPath(repoUrl)) {
    const repoPath = path.resolve(repoUrl);
    if (!fs.existsSync(repoPath)) {
      throw new Error(`Local path does not exist: ${repoPath}`);
    }
    const repoName = path.basename(repoPath);
    return {
      repoPath,
      repoName,
      cleanup: async () => { /* no-op — don't delete local repos */ },
    };
  }

  // ── Remote URL: git clone ─────────────────────────────────────────────────
  const repoPath = targetDir ?? buildTargetDir();
  const repoName = extractRepoName(repoUrl);

  const spin = spinner(`Cloning ${repoName}...`);

  try {
    await fs.promises.mkdir(repoPath, { recursive: true });

    const git = simpleGit();
    await git.clone(repoUrl, repoPath, ["--depth", "1"]);

    spin.succeed(`Cloned ${repoName}`);
  } catch (err) {
    spin.fail(`Failed to clone ${repoName}`);
    await removeDir(repoPath);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to clone repository "${repoUrl}": ${message}`);
  }

  const cleanup = async (): Promise<void> => {
    await removeDir(repoPath);
  };

  return { repoPath, repoName, cleanup };
}
