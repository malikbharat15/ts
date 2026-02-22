import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";

// MODEL: always claude-sonnet-4-6 — hardcoded, not configurable
// DO NOT change this — fixes the model for reproducibility
const MODEL = "claude-sonnet-4-6";

// Type alias for a system block that includes optional cache_control.
// The Anthropic SDK ^0.24.0 TextBlockParam does not yet expose cache_control in
// its TypeScript types, but the underlying API supports it for prompt caching.
// We cast through unknown to pass the runtime value safely.
type CachedTextBlock = Anthropic.TextBlockParam & {
  cache_control?: { type: "ephemeral" };
};

function getClient(): Anthropic {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is not set. " +
        "Please set it before running smokeforge."
    );
  }
  return new Anthropic({ apiKey });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// LLM debug logging — writes each chunk's prompt to smokeforge-output/llm-debug/
// ---------------------------------------------------------------------------
let _chunkCounter = 0;

function writeDebugLog(systemPrompt: string, userMessage: string): void {
  try {
    const debugDir = path.resolve(process.cwd(), "smokeforge-output", "llm-debug");
    fs.mkdirSync(debugDir, { recursive: true });
    const index = String(++_chunkCounter).padStart(3, "0");

    // Extract domain label from the user message for a descriptive filename
    const domainMatch = userMessage.match(/^##\s*DOMAIN:\s*(.+)$/m);
    const domain = domainMatch ? domainMatch[1].trim().replace(/\s+/g, "-") : "unknown";
    const baseName = `chunk-${index}-${domain}`;

    // 1. Raw JSON (machine-readable)
    const jsonPayload = {
      chunk: _chunkCounter,
      domain,
      timestamp: new Date().toISOString(),
      systemPrompt,
      userMessage,
    };
    fs.writeFileSync(
      path.join(debugDir, `${baseName}.json`),
      JSON.stringify(jsonPayload, null, 2),
      "utf8"
    );

    // 2. Markdown (human-readable) — renders nicely in VS Code
    // Try to pretty-print any embedded JSON block inside the user message
    let prettyUserMessage = userMessage.replace(
      /(\n## API ENDPOINTS TO TEST:\n)([\s\S]*?)(\n\n## )/,
      (_match, before, rawJson, after) => {
        try {
          return `${before}\`\`\`json\n${JSON.stringify(JSON.parse(rawJson.trim()), null, 2)}\n\`\`\`${after}`;
        } catch {
          return _match;
        }
      }
    );
    // Wrap AUTH CONFIGURATION block too
    prettyUserMessage = prettyUserMessage.replace(
      /(\n## AUTH CONFIGURATION:\n)([\s\S]*?)(\n\n## )/,
      (_match, before, rawJson, after) => {
        try {
          return `${before}\`\`\`json\n${JSON.stringify(JSON.parse(rawJson.trim()), null, 2)}\n\`\`\`${after}`;
        } catch {
          return _match;
        }
      }
    );

    const md = [
      `# Chunk ${index} — ${domain}`,
      `**Timestamp:** ${new Date().toISOString()}`,
      "",
      "---",
      "",
      "## 🔧 System Prompt",
      "",
      "```",
      systemPrompt.trim(),
      "```",
      "",
      "---",
      "",
      "## 📨 User Message",
      "",
      prettyUserMessage.trim(),
      "",
    ].join("\n");

    fs.writeFileSync(path.join(debugDir, `${baseName}.md`), md, "utf8");
  } catch {
    // never crash the main flow due to debug logging
  }
}

export async function generateWithRetry(
  systemPrompt: string,
  userMessage: string,
  maxRetries: number = 2
): Promise<string> {
  // Validate API key before any network call
  const client = getClient();

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Write debug log on first attempt only
      if (attempt === 0) {
        writeDebugLog(systemPrompt, userMessage);
      }
      // Build a cached system block. The cast is required because SDK ^0.24.0
      // types do not expose cache_control on TextBlockParam, but the API supports it.
      const systemBlock: CachedTextBlock = {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      };

      const message = await client.messages.create({
        model: MODEL,
        max_tokens: 8192,
        temperature: 0.1, // low temp for deterministic code generation
        system: [systemBlock as unknown as Anthropic.TextBlockParam],
        messages: [{ role: "user", content: userMessage }],
      });

      const content = message.content[0];
      if (content.type !== "text") {
        throw new Error("Non-text response received from Anthropic API");
      }
      return content.text;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        // Exponential backoff: 1000ms, 2000ms
        await sleep(1000 * (attempt + 1));
      }
    }
  }

  // All retries exhausted — throw the last error
  throw lastError ?? new Error("generateWithRetry failed with no error details");
}
