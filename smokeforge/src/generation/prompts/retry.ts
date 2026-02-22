export function buildRetryMessage(
  originalOutput: string,
  validationErrors: string[]
): string {
  return `
The previous generation had errors. Fix ONLY the issues listed below and regenerate the COMPLETE file.

## ERRORS TO FIX:
${validationErrors.map((e, i) => `${i + 1}. ${e}`).join("\n")}

## PREVIOUS (BROKEN) OUTPUT:
${originalOutput}

Regenerate the complete corrected file now. Output ONLY valid TypeScript/JSON.
`.trim();
}
