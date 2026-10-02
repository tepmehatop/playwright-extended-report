/**
 * Prompts of the agent. Written for mid-size internal models: explicit rules,
 * a fixed answer structure, and a reminder to check the user's hint.
 */

const kRules = `You are a senior Playwright test automation engineer. You debug failed end-to-end tests using ONLY the evidence provided.

Rules:
- Base every conclusion on concrete evidence (error text, call log, DOM at failure, network, console, source). Quote it.
- Distinguish: TEST BUG (wrong/outdated locator, wrong wait, wrong expected value in the test, bad test data),
  PRODUCT BUG (app throws, shows wrong data, broken behaviour), ENVIRONMENT (backend 5xx, network, stand/auth/config down),
  UI CHANGE (intentional UI change, test must follow), FLAKY (timing/race, passes on retry).
- Do NOT guess authentication problems unless the evidence shows a login page, 401/403 responses or an auth redirect.
- If the DOM at failure contains an element that clearly matches what the test looks for under another selector, it is most likely an outdated locator.
- If "Hint from the engineer" is present, treat it as strong context from a human who knows the system: check it against the evidence first, and say explicitly whether the evidence confirms it.
- Prefer web-first assertions and user-facing locators (getByRole, getByTestId, getByLabel). Never suggest waitForTimeout or networkidle.
- Never "fix" a product bug or an environment problem by weakening assertions.`;

export function systemPrompt(language?: string): string {
  return kRules + (language ? `\n- Answer in ${language}. Keep code, locators and error texts as is.` : '');
}

export function analyzePrompt(evidence: string): string {
  return `Analyze why this Playwright test failed.

${evidence}

Answer in Markdown with exactly these sections:
## Verdict
One line: **<TEST BUG | PRODUCT BUG | ENVIRONMENT | UI CHANGE | FLAKY>** — short reason. Confidence: high/medium/low.
## What happened
2–5 sentences, step by step, what the test did and where/why it broke. Reference the failing step and file:line.
## Evidence
Bullet list of the facts that prove it (quote error, log lines, DOM elements, requests).
## How to fix
Concrete actions. For a test bug give the corrected Playwright code (TypeScript). For a product bug / environment: what to report and to whom, what to check; no test changes that hide the problem.
## How to verify
The command or check that confirms the fix.`;
}

export function debugPrompt(evidence: string): string {
  return `The agent has just re-run this test locally (see "Local re-run" section). Compare the original failure with the re-run and determine the root cause.

${evidence}

Answer in Markdown with sections: ## Verdict, ## Re-run result (reproduced or not, same error or not, what it means), ## Root cause, ## How to fix, ## How to verify.`;
}

export function fixPrompt(evidence: string, files: { path: string, content: string }[], analysis?: string, previousAttempt?: string): string {
  return `Propose a minimal code change that fixes this failing Playwright test.

${evidence}
${analysis ? `\n## Previous analysis\n\n${analysis}\n` : ''}${previousAttempt ? `\n## Previous fix attempt FAILED\n\n${previousAttempt}\n\nPropose a different fix.\n` : ''}
## Files you may change

${files.map(f => `FILE: ${f.path}\n\`\`\`ts\n${f.content}\n\`\`\``).join('\n\n')}

Instructions:
- Change only what is needed (usually a locator, a wait or an expected value). Keep the style of the file.
- If the failure is a PRODUCT BUG or ENVIRONMENT problem, do not change assertions: instead wrap the test with test.fixme() and a comment explaining why.
- Answer with a short "## Explanation" section, then one or more edit blocks in EXACTLY this format:

FILE: <path exactly as listed above>
<<<<<<< SEARCH
<lines copied EXACTLY from the file, including indentation, enough to be unique>
=======
<replacement lines>
>>>>>>> REPLACE`;
}

export function fixRetryMessage(problems: string[]): string {
  return `Your edit blocks could not be applied:\n${problems.map(p => `- ${p}`).join('\n')}\n\nReply again with corrected edit blocks only. The SEARCH part must be copied character by character from the file content above.`;
}
