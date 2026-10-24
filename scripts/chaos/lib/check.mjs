export function checks() {
  const results = [];
  return {
    results,
    check(id, description, passed, evidence = {}, kind = "hard") {
      const result = {
        id,
        description,
        kind,
        passed: Boolean(passed),
        status: passed ? "pass" : "fail",
        evidence,
      };
      results.push(result);
      return result;
    },
    notReached(id, description, why, evidence = {}) {
      const result = {
        id,
        description,
        kind: "hard",
        passed: false,
        status: "not_reached",
        evidence: { ...evidence, reason: why },
      };
      results.push(result);
      return result;
    },
  };
}
