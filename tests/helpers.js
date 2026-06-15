// Minimal test helpers (no deps). Each test file imports these.
let passed = 0;
let failed = 0;
const failures = [];

export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${msg}\n   expected ${e}\n   got      ${a}`);
  }
}

export function ok(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(`FAIL: ${msg}`);
  }
}

export function approx(actual, expected, msg, tol = 1e-9) {
  if (Math.abs(actual - expected) <= tol) passed++;
  else {
    failed++;
    failures.push(`FAIL: ${msg}\n   expected ~${expected}\n   got       ${actual}`);
  }
}

export function report(label) {
  console.log(`\n=== ${label} ===`);
  for (const f of failures) console.log(f);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  return failed === 0;
}
