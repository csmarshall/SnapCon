# Review and Planning Guide

Read this file for code-review, repository-audit, and planning-only tasks.

## Finding classification

When reviewing or investigating code, classify findings as:

**BUG NOW**
Current behavior is demonstrably incorrect.

**RISK**
Current behavior works but has a realistic failure mode.

**SCALING**
Current behavior is acceptable today but becomes problematic at realistic larger fleet sizes.

**MAINTENANCE**
The issue primarily increases future development or debugging risk.

**OPTIONAL**
A valid improvement that is not currently necessary.

Do not inflate severity.

Distinguish theoretical concerns from realistic failure scenarios.

For security findings distinguish:

**CONFIRMED FROM CODE**

from:

**REQUIRES LIVE VERIFICATION**

Do not present inferred environmental behavior as a confirmed vulnerability.

A previous audit/review document is not current-state evidence.

Re-verify every finding against current source.

## Review standard

A useful review finding must contain:

- specific file/function;
- evidence from current source;
- realistic failure scenario;
- why it matters to SnapCon;
- recommended direction;
- implementation complexity;
- regression risk;
- confidence.

Avoid style comments unless they materially affect correctness or maintainability.

Prefer 10 strong findings over 100 weak ones.

Do not produce lint-style noise during architecture or code reviews.

For P0/P1 or otherwise high-severity findings, independently re-read the relevant source before reporting them.

When using parallel reviewers/subagents, their findings are leads.

The primary reviewer must independently verify high-severity findings before accepting them.

For security findings involving environmental behavior not visible in source — for example Cloudflare forwarding behavior, reverse-proxy source addresses, operating-system behavior, or external-service semantics — state that live verification is required.

## Planning standard

When asked to plan rather than implement:

- investigate current code first;
- verify the premise;
- trace the complete affected flow;
- identify exact files/functions;
- identify existing patterns worth reusing;
- describe before/after behavior;
- identify edge cases;
- identify tests;
- identify non-goals;
- estimate complexity and regression risk;
- challenge the plan before presenting it.

Do not modify production code during a planning-only task.

A plan should be detailed enough that implementation is unambiguous without becoming a speculative redesign.

Before finalizing a plan, challenge it:

- Is there a simpler fix?
- Am I fixing a symptom instead of the cause?
- Does another subsystem depend on today's behavior?
- Does the other Remote Access repository depend on today's behavior?
- Could the change break a connector?
- Does it require migration/backward compatibility?
- Is every planned change actually necessary?

Remove unnecessary work before presenting the plan.
