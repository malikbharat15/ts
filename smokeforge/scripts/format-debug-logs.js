#!/usr/bin/env node
/**
 * format-debug-logs.js
 * Converts all llm-debug/chunk-*.json files into readable Markdown.
 * Usage:  node scripts/format-debug-logs.js [debug-dir]
 * Default debug-dir: smokeforge-output/llm-debug
 */

const fs   = require("fs");
const path = require("path");

const debugDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, "../smokeforge-output/llm-debug");

if (!fs.existsSync(debugDir)) {
  console.error(`Directory not found: ${debugDir}`);
  process.exit(1);
}

const jsonFiles = fs.readdirSync(debugDir)
  .filter(f => f.endsWith(".json"))
  .sort();

if (jsonFiles.length === 0) {
  console.log("No JSON debug files found.");
  process.exit(0);
}

let converted = 0;

for (const file of jsonFiles) {
  const jsonPath = path.join(debugDir, file);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch (e) {
    console.warn(`  SKIP ${file} — invalid JSON: ${e.message}`);
    continue;
  }

  const { chunk, timestamp, domain, systemPrompt, userMessage } = data;
  const domainLabel = domain || "unknown";
  const index = String(chunk).padStart(3, "0");

  // Pretty-print any JSON blocks embedded in userMessage
  function prettyBlock(text, sectionHeader) {
    const re = new RegExp(`(${sectionHeader}:\\n)([\\s\\S]*?)(?=\\n\\n## |$)`);
    return text.replace(re, (match, header, body) => {
      try {
        return `${header}\`\`\`json\n${JSON.stringify(JSON.parse(body.trim()), null, 2)}\n\`\`\``;
      } catch {
        return match;
      }
    });
  }

  let msg = userMessage || "";
  msg = prettyBlock(msg, "## AUTH CONFIGURATION");
  msg = prettyBlock(msg, "## API ENDPOINTS TO TEST");
  msg = prettyBlock(msg, "## TEST DATA HINTS");

  // Replace remaining ## headers with ### so they nest under the User Message heading
  msg = msg.replace(/^## /gm, "### ");

  const md = [
    `# Chunk ${index} — ${domainLabel}`,
    `**Timestamp:** ${timestamp || "n/a"}`,
    "",
    "---",
    "",
    "## 🔧 System Prompt",
    "",
    "```",
    (systemPrompt || "").trim(),
    "```",
    "",
    "---",
    "",
    "## 📨 User Message",
    "",
    msg.trim(),
    "",
  ].join("\n");

  const mdName = file.replace(".json", ".md");
  // If the filename doesn't already have the domain, append it
  const finalName = mdName.includes(domainLabel) ? mdName : mdName.replace(".md", `-${domainLabel}.md`);
  const mdPath = path.join(debugDir, finalName);
  fs.writeFileSync(mdPath, md, "utf8");
  console.log(`  ✔ ${file} → ${finalName}`);
  converted++;
}

console.log(`\nDone. Converted ${converted}/${jsonFiles.length} files.`);
