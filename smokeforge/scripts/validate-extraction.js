#!/usr/bin/env node
/**
 * validate-extraction.js
 * Compares extracted blueprint fields against known source truth for complex POST endpoints.
 */

const bp = require("../blueprint.json");

const EXPECTED = {
  "POST /api/v1/employees/": {
    fields: ["firstName", "lastName", "email", "departmentId", "jobTitle", "startDate", "salary", "employmentType"],
    fieldTypes: {
      firstName: "string", lastName: "string", email: "string",
      departmentId: "uuid", jobTitle: "string", startDate: "string",
      salary: "number", employmentType: "enum"
    },
    requiredFields: ["firstName", "lastName", "email", "departmentId", "jobTitle", "startDate", "salary", "employmentType"],
    queryParams: [],
    roles: ["admin", "hr_manager"],
  },
  "POST /api/v1/payroll/run": {
    fields: ["month", "year", "departmentIds"],
    fieldTypes: { month: "number", year: "number", departmentIds: "array" },
    requiredFields: ["month", "year"],
    queryParams: [],
    roles: ["admin"],
  },
  "POST /api/v1/payroll/employees/:employeeId/bonus": {
    fields: ["amount", "reason", "date"],
    fieldTypes: { amount: "number", reason: "string", date: "string" },
    requiredFields: ["amount", "reason", "date"],
    queryParams: [],
    roles: ["admin"],
  },
};

let totalChecks = 0;
let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  totalChecks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✅  ${label}`);
  } else {
    failed++;
    console.log(`  ❌  ${label}`);
    console.log(`      Expected: ${JSON.stringify(expected)}`);
    console.log(`      Got:      ${JSON.stringify(actual)}`);
  }
}

for (const [key, expected] of Object.entries(EXPECTED)) {
  const [method, path] = key.split(" ");
  const ep = bp.endpoints.find(e => e.method === method && e.path === path);

  console.log(`\n══ ${key} ══`);

  if (!ep) {
    console.log(`  ❌  Endpoint NOT FOUND in blueprint`);
    failed++; totalChecks++;
    continue;
  }

  // 1. Check all expected fields are present
  const extractedFieldNames = (ep.requestBody?.fields ?? []).map(f => f.name).sort();
  check("request body field names", extractedFieldNames, [...expected.fields].sort());

  // 2. Check field types
  const extractedTypes = {};
  for (const f of (ep.requestBody?.fields ?? [])) {
    extractedTypes[f.name] = f.type;
  }
  for (const [name, expectedType] of Object.entries(expected.fieldTypes)) {
    check(`field '${name}' type`, extractedTypes[name], expectedType);
  }

  // 3. Check required fields
  const extractedRequired = (ep.requestBody?.fields ?? [])
    .filter(f => f.required)
    .map(f => f.name)
    .sort();
  check("required fields", extractedRequired, [...expected.requiredFields].sort());

  // 4. Check queryParams
  check("queryParams", ep.queryParams, expected.queryParams);

  // 5. Check roles
  check("roles extracted", ep.roles.sort(), [...expected.roles].sort());
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Result: ${passed}/${totalChecks} checks passed  (${failed} failed)`);
process.exit(failed > 0 ? 1 : 0);
