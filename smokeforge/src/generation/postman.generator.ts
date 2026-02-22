import type { BlueprintChunk } from "../blueprint/chunker";

export function buildPostmanUserMessage(chunk: BlueprintChunk): string {
  return `
Generate a Postman Collection v2.1 JSON for the following application chunk.

## AUTH CONFIGURATION:
${JSON.stringify(chunk.auth, null, 2)}

## API ENDPOINTS TO TEST:
${JSON.stringify(chunk.endpoints, null, 2)}

## UI PAGES TO TEST:
${JSON.stringify(chunk.pages, null, 2)}

## TEST DATA HINTS:
${JSON.stringify(chunk.testDataHints, null, 2)}

## DOMAIN: ${chunk.domain}
## OUTPUT FILE NAME: ${chunk.outputFileName}

Generate the complete Postman collection JSON now. Output ONLY valid JSON starting with { and ending with }.
`.trim();
}
