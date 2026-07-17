import fs from 'node:fs';
import path from 'node:path';

const EXPECTED_REPOSITORY = 'denishengrossinfotech-micro1/workflow-automation';
const EXPECTED_BASE_BRANCH = 'main';
const TEST_DOCUMENT_ID = '1-rPe-USNWulp7IKKN8ZVfD19ArOW00QAEQ1v9an5ct0';
const TEST_DOCUMENT_TITLE = 'Test Case: Login Button Functionality';
const FALLBACK_RECIPIENT = 'denish.engrossinfotech@expert.micro1.ai';
const SUBJECT = 'Regression Detected After Merge';
const artifactsDir = path.resolve('artifacts');
const baselineDir = path.resolve('.regression-baseline');

fs.mkdirSync(artifactsDir, { recursive: true });
fs.mkdirSync(baselineDir, { recursive: true });

const jsonPath = (name) => path.join(artifactsDir, name);
const readJson = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (name, value) => fs.writeFileSync(jsonPath(name), `${JSON.stringify(value, null, 2)}\n`);
const appendOutput = (name, value) => {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value)}\n`);
};
const appendSummary = (text) => {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
};

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable or secret ${name} is not configured.`);
  return value;
}

async function fetchJson(url, options = {}, label = url) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}: ${text.slice(0, 1000)}`);
  try { return JSON.parse(text); } catch { throw new Error(`${label} returned invalid JSON.`); }
}

async function github(apiPath) {
  return fetchJson(`https://api.github.com${apiPath}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${required('GITHUB_TOKEN')}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'workflow-automation-post-merge-regression',
    },
  }, `GitHub API ${apiPath}`);
}

async function googleAccessToken() {
  const body = new URLSearchParams({
    client_id: required('GOOGLE_CLIENT_ID'),
    client_secret: required('GOOGLE_CLIENT_SECRET'),
    refresh_token: required('GOOGLE_REFRESH_TOKEN'),
    grant_type: 'refresh_token',
  });
  const token = await fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }, 'Google OAuth token refresh');
  if (!token.access_token) throw new Error('Google OAuth response did not include an access token.');
  return token.access_token;
}

async function driveText(accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const metadata = await fetchJson(
    `https://www.googleapis.com/drive/v3/files/${TEST_DOCUMENT_ID}?fields=id,name,mimeType,modifiedTime&supportsAllDrives=true`,
    { headers },
    'Google Drive document metadata',
  );
  if (metadata.name !== TEST_DOCUMENT_TITLE) {
    throw new Error(`Google Drive file ID resolved to ${JSON.stringify(metadata.name)}, expected ${JSON.stringify(TEST_DOCUMENT_TITLE)}.`);
  }
  if (metadata.mimeType !== 'application/vnd.google-apps.document') {
    throw new Error(`Google Drive file is ${metadata.mimeType}, expected a native Google Doc.`);
  }
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${TEST_DOCUMENT_ID}/export?mimeType=text%2Fplain`,
    { headers },
  );
  const content = await response.text();
  if (!response.ok) throw new Error(`Google Drive export failed with HTTP ${response.status}: ${content.slice(0, 1000)}`);
  if (!content.trim()) throw new Error('The test case document is empty.');
  return { metadata, content };
}

function validHumanEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !/noreply|users\.noreply/i.test(value);
}

function affectedFeatures(files) {
  const groups = new Set();
  for (const file of files) {
    const name = file.filename.toLowerCase();
    if (/login|auth|session|user/.test(name)) groups.add('authentication and login');
    if (/src\/|app\.|component|page|view|css|html/.test(name)) groups.add('user interface');
    if (/api|server|route|service|controller/.test(name)) groups.add('API and business logic');
    if (/package(-lock)?\.json|npm-shrinkwrap|yarn\.lock|pnpm-lock/.test(name)) groups.add('dependencies');
    if (/(^|\/)(\.github|config|vite|playwright)|\.ya?ml$|\.env/.test(name)) groups.add('configuration and CI');
  }
  return [...groups];
}

async function pagedPullFiles(repository, number) {
  const files = [];
  for (let page = 1; ; page += 1) {
    const batch = await github(`/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) break;
    if (page >= 30) throw new Error('Pull request changed-file list exceeded the safety pagination limit.');
  }
  return files;
}

async function prepare() {
  const event = readJson(required('GITHUB_EVENT_PATH'));
  const repository = event?.repository?.full_name;
  if (repository !== EXPECTED_REPOSITORY || process.env.GITHUB_REPOSITORY !== EXPECTED_REPOSITORY) {
    throw new Error(`Repository guard rejected ${repository || process.env.GITHUB_REPOSITORY || 'unknown'}; this workflow only runs for ${EXPECTED_REPOSITORY}.`);
  }
  if (event?.action !== 'closed' || event?.pull_request?.merged !== true) {
    throw new Error('Event guard rejected this run because it is not a successfully merged pull request.');
  }
  if (event.pull_request.base?.ref !== EXPECTED_BASE_BRANCH) {
    throw new Error(`Base-branch guard rejected ${event.pull_request.base?.ref}; expected ${EXPECTED_BASE_BRANCH}.`);
  }

  const number = event.pull_request.number;
  const pr = await github(`/repos/${repository}/pulls/${number}`);
  const files = await pagedPullFiles(repository, number);
  const mergeSha = pr.merge_commit_sha || event.pull_request.merge_commit_sha;
  if (!mergeSha) throw new Error('GitHub did not return a merge commit hash.');
  const commit = await github(`/repos/${repository}/commits/${mergeSha}`);

  const mergedBy = pr.merged_by?.login || event.pull_request.merged_by?.login || 'unknown';
  let publicProfile = null;
  if (mergedBy !== 'unknown') {
    try { publicProfile = await github(`/users/${encodeURIComponent(mergedBy)}`); } catch { publicProfile = null; }
  }
  const candidateEmails = [
    publicProfile?.email,
    commit?.commit?.committer?.email,
    commit?.commit?.author?.email,
  ];
  const mergeAuthorEmail = candidateEmails.find(validHumanEmail) || null;
  const recipient = mergeAuthorEmail || FALLBACK_RECIPIENT;

  const normalizedFiles = files.map((file) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    previousFilename: file.previous_filename || null,
    patch: file.patch || null,
  }));
  const byStatus = (status) => normalizedFiles.filter((file) => file.status === status).map((file) => file.filename);
  const features = affectedFeatures(normalizedFiles);
  const dependencyFiles = normalizedFiles.filter((file) => /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/i.test(file.filename)).map((file) => file.filename);
  const configurationFiles = normalizedFiles.filter((file) => /(^|\/)(\.github|config)|(^|\/)(vite|playwright)\.|\.ya?ml$|\.toml$|\.env/i.test(file.filename)).map((file) => file.filename);
  const quickSummary = `PR #${number} (${pr.title}) merged ${pr.head.ref} into ${pr.base.ref} with ${normalizedFiles.length} changed file(s): ${byStatus('added').length} added, ${byStatus('modified').length} modified, ${byStatus('removed').length} deleted${features.length ? `; likely areas: ${features.join(', ')}` : ''}.`;

  const mergeDetails = {
    repository: { fullName: repository, id: event.repository.id, htmlUrl: event.repository.html_url, defaultBranch: event.repository.default_branch },
    pullRequest: {
      number,
      title: pr.title,
      description: pr.body || '',
      htmlUrl: pr.html_url,
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      mergeCommitSha: mergeSha,
      mergedBy,
      mergedAt: pr.merged_at,
      author: pr.user?.login || null,
    },
    mergeCommit: {
      sha: mergeSha,
      htmlUrl: commit.html_url,
      message: commit.commit?.message || '',
      authoredAt: commit.commit?.author?.date || null,
      committedAt: commit.commit?.committer?.date || null,
    },
    recipient: { selected: recipient, mergeAuthorEmail, fallback: FALLBACK_RECIPIENT },
    changes: {
      totalFiles: normalizedFiles.length,
      added: byStatus('added'),
      modified: byStatus('modified'),
      deleted: byStatus('removed'),
      renamed: byStatus('renamed'),
      files: normalizedFiles,
      impactedFeatures: features,
      dependencyFiles,
      configurationFiles,
    },
    quickSummary,
  };
  writeJson('merge-details.json', mergeDetails);
  fs.writeFileSync(jsonPath('merge-summary.txt'), `${quickSummary}\n`);
  appendSummary(`## Merge summary\n\n${quickSummary}`);

  const token = await googleAccessToken();
  const document = await driveText(token);
  fs.writeFileSync(jsonPath('test-document.txt'), document.content);
  writeJson('test-document-metadata.json', {
    ...document.metadata,
    url: `https://docs.google.com/document/d/${TEST_DOCUMENT_ID}/edit`,
    bytesRead: Buffer.byteLength(document.content),
  });

  const requiredPhrases = [
    'TC-LOGIN-001',
    'The Login button triggers the authentication request',
    'A login API request is sent',
    'The user is redirected to the Dashboard',
    'Invalid email or password',
    'No browser console errors are generated',
  ];
  const missing = requiredPhrases.filter((phrase) => !document.content.includes(phrase));
  if (missing.length) throw new Error(`Test document is missing required specification statements: ${missing.join('; ')}`);

  const invalidMessage = document.content.match(/displays the message\s*:\s*["“]([^"”]+)["”]/i)?.[1]?.trim();
  if (!invalidMessage) throw new Error('Could not extract the documented invalid-credentials message.');
  const docBaseUrl = document.content.match(/^\s*(?:Base URL|Application URL)\s*:\s*(https?:\/\/\S+)\s*$/im)?.[1];
  const docEmail = document.content.match(/^\s*(?:Test (?:user )?email|Email|Username)\s*:\s*([^\s]+@[^\s]+)\s*$/im)?.[1];
  const docPassword = document.content.match(/^\s*(?:Test (?:user )?password|Password)\s*:\s*(\S+)\s*$/im)?.[1];
  const baseUrl = docBaseUrl || process.env.REGRESSION_BASE_URL || 'http://127.0.0.1:4173';
  const email = docEmail || process.env.REGRESSION_TEST_EMAIL;
  const password = docPassword || process.env.REGRESSION_TEST_PASSWORD;
  if (!email || !password) {
    throw new Error('The Google Doc does not contain literal test credentials, and REGRESSION_TEST_EMAIL / REGRESSION_TEST_PASSWORD are not configured.');
  }
  process.env.REGRESSION_TEST_EMAIL = email;
  process.env.REGRESSION_TEST_PASSWORD = password;
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `REGRESSION_BASE_URL=${baseUrl}\n`);
    fs.appendFileSync(process.env.GITHUB_ENV, `REGRESSION_TEST_EMAIL=${email}\n`);
    fs.appendFileSync(process.env.GITHUB_ENV, `REGRESSION_TEST_PASSWORD=${password}\n`);
  }

  writeJson('test-spec.json', {
    document: {
      id: TEST_DOCUMENT_ID,
      title: TEST_DOCUMENT_TITLE,
      modifiedTime: document.metadata.modifiedTime,
      bytesRead: Buffer.byteLength(document.content),
      completelyRead: true,
    },
    testCaseId: 'TC-LOGIN-001',
    feature: 'Login',
    runtime: {
      baseUrl,
      baseUrlSource: docBaseUrl ? 'google-document' : process.env.REGRESSION_BASE_URL ? 'github-configuration' : 'workflow-local-preview',
      credentialsSource: docEmail && docPassword ? 'google-document' : 'github-secrets',
    },
    expectations: {
      authRequestRequired: true,
      validCredentialsOpenDashboard: true,
      invalidCredentialsMessage: invalidMessage,
      invalidCredentialsRemainOnLogin: true,
      noConsoleErrors: true,
      noJavaScriptExceptions: true,
      noUnexpectedNetworkStatus: true,
    },
  });
  appendOutput('prepared', 'true');
}

function flattenPlaywright(report) {
  const tests = [];
  const walk = (suite, parents = []) => {
    const suiteParents = suite.title ? [...parents, suite.title] : parents;
    for (const spec of suite.specs || []) {
      for (const projectTest of spec.tests || []) {
        const result = projectTest.results?.at(-1) || {};
        const title = [...suiteParents, spec.title, projectTest.projectName].filter(Boolean).join(' › ');
        tests.push({
          id: title,
          title,
          file: spec.file,
          line: spec.line,
          status: result.status || 'unknown',
          expectedStatus: projectTest.expectedStatus,
          durationMs: result.duration || 0,
          errors: (result.errors || []).map((error) => ({ message: error.message || '', stack: error.stack || '', snippet: error.snippet || '' })),
          attachments: result.attachments || [],
        });
      }
    }
    for (const child of suite.suites || []) walk(child, suiteParents);
  };
  for (const suite of report?.suites || []) walk(suite);
  return tests;
}

function readTelemetry(tests) {
  const combined = { consoleErrors: [], javascriptExceptions: [], requestFailures: [], responses: [], navigations: [] };
  for (const item of tests) {
    for (const attachment of item.attachments || []) {
      if (attachment.name !== 'runtime-telemetry.json' || !attachment.path) continue;
      const telemetry = readJson(path.resolve(attachment.path));
      if (!telemetry) continue;
      for (const key of Object.keys(combined)) combined[key].push(...(telemetry[key] || []).map((entry) => ({ test: item.title, ...entry })));
    }
  }
  return combined;
}

function rootCauseCandidates(merge, failingTests) {
  const errorText = failingTests.flatMap((test) => test.errors.flatMap((error) => [error.message, error.stack, error.snippet])).join('\n').toLowerCase();
  return merge.changes.files.map((file) => {
    const name = file.filename.toLowerCase();
    let score = 0;
    const reasons = [];
    if (/login|auth|session|credential|button/.test(name)) { score += 8; reasons.push('filename matches failing login/authentication behavior'); }
    if (/src\/|app\.|component|page|view/.test(name)) { score += 4; reasons.push('runtime UI source changed'); }
    if (/api|server|route|service|controller/.test(name)) { score += 5; reasons.push('API or business-logic source changed'); }
    if (/package(-lock)?\.json|npm-shrinkwrap|yarn\.lock|pnpm-lock/.test(name)) { score += 3; reasons.push('dependency graph changed'); }
    if (/(^|\/)(\.github|config)|(^|\/)(vite|playwright)\.|\.ya?ml$|\.toml$|\.env/.test(name)) { score += 2; reasons.push('configuration changed'); }
    if (errorText.includes(name) || errorText.includes(path.basename(name))) { score += 10; reasons.push('failure stack references this file'); }
    if (/login|auth|dashboard|invalid email or password/i.test(file.patch || '')) { score += 6; reasons.push('patch touches documented login behavior'); }
    return { file: file.filename, score, reasons, patch: file.patch || null };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
}

function escapeTable(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function analyze() {
  const merge = readJson(jsonPath('merge-details.json'));
  const spec = readJson(jsonPath('test-spec.json'));
  const firstReport = readJson(jsonPath('playwright-first.json'));
  const rerunReport = readJson(jsonPath('playwright-rerun.json'), { suites: [] });
  if (!merge || !spec || !firstReport) throw new Error('Required merge, specification, or Playwright result data is missing.');

  const first = flattenPlaywright(firstReport);
  const rerun = flattenPlaywright(rerunReport);
  const rerunMap = new Map(rerun.map((test) => [test.id, test]));
  const baseline = readJson(path.join(baselineDir, 'baseline.json'), { passed: [], source: 'none' });
  const baselinePassed = new Set(baseline.passed || []);
  const failed = first.filter((test) => test.status !== 'passed' && test.status !== 'skipped');
  const reproduced = failed.filter((test) => rerunMap.get(test.id)?.status !== 'passed');
  const flaky = failed.filter((test) => rerunMap.get(test.id)?.status === 'passed');
  const confirmed = reproduced.filter((test) => baselinePassed.has(test.id) && test.title.includes('@doc:TC-LOGIN-001'));
  const newOrUnbaselined = reproduced.filter((test) => !baselinePassed.has(test.id));
  const passed = first.filter((test) => test.status === 'passed');
  const skipped = first.filter((test) => test.status === 'skipped');
  const durationMs = first.reduce((sum, test) => sum + test.durationMs, 0);
  const telemetry = readTelemetry([...first, ...rerun]);
  const candidates = rootCauseCandidates(merge, reproduced);

  let classification = 'HEALTHY';
  if (confirmed.length) classification = 'CONFIRMED_REGRESSION';
  else if (flaky.length) classification = 'FLAKY_VALIDATION_FAILURE';
  else if (reproduced.length) classification = baselinePassed.size ? 'NON_BASELINE_TEST_FAILURE' : 'BASELINE_NOT_ESTABLISHED';

  const severity = confirmed.some((test) => /valid credentials/.test(test.title)) ? 'Critical' : confirmed.length ? 'High' : reproduced.length ? 'Unconfirmed' : 'None';
  const risk = confirmed.length ? 'High risk to authentication availability and user access; production promotion should be blocked.' : reproduced.length ? 'Validation is not healthy, but regression criteria are incomplete; investigate before production.' : 'No confirmed regression found.';
  const rootCause = confirmed.length ? {
    introducingCommit: merge.pullRequest.mergeCommitSha,
    confidence: candidates[0]?.score >= 12 ? 'high' : candidates.length ? 'medium' : 'low',
    probableFiles: candidates,
    executionBreaks: confirmed.flatMap((test) => test.errors.map((error) => ({ test: test.title, file: test.file, line: test.line, message: error.message, stack: error.stack }))),
    dependencyContribution: merge.changes.dependencyFiles,
    configurationContribution: merge.changes.configurationFiles,
  } : null;

  const analysis = {
    classification,
    regressionDetected: confirmed.length > 0,
    workflowFailure: failed.length > 0,
    baseline: { available: baselinePassed.size > 0, passedTests: [...baselinePassed] },
    summary: { total: first.length, passed: passed.length, failed: failed.length, skipped: skipped.length, durationMs },
    failedTests: failed,
    reproducedTests: reproduced.map((test) => test.id),
    flakyTests: flaky.map((test) => test.id),
    confirmedRegressions: confirmed.map((test) => test.id),
    newOrUnbaselinedFailures: newOrUnbaselined.map((test) => test.id),
    telemetry,
    rootCause,
    severity,
    risk,
  };
  writeJson('analysis.json', analysis);

  const statusLabel = classification === 'HEALTHY' ? 'PASSED' : 'FAILED';
  const changedRows = merge.changes.files.map((file) => `| ${escapeTable(file.filename)} | ${file.status} | +${file.additions} / -${file.deletions} |`).join('\n') || '| None | — | — |';
  const failureRows = failed.map((test) => `| ${escapeTable(test.title)} | ${test.status} | ${rerunMap.get(test.id)?.status || 'not rerun'} | ${baselinePassed.has(test.id) ? 'yes' : 'no'} |`).join('\n') || '| None | — | — | — |';
  const probable = candidates.length ? candidates.map((item, index) => `${index + 1}. \`${item.file}\` — ${item.reasons.join('; ')} (score ${item.score})`).join('\n') : 'No changed file could be ranked from the available runtime evidence.';
  const breaks = reproduced.flatMap((test) => test.errors.map((error) => `- **${test.title}**: ${error.message.split('\n')[0]}${error.stack ? `\n\n  Runtime stack: \`${error.stack.split('\n')[0]}\`` : ''}`)).join('\n') || '- None';
  const report = `# Post-Merge Regression Report\n\n## Classification\n\n**${classification}** — ${classification === 'CONFIRMED_REGRESSION' ? 'All regression gates were satisfied: previously passing, document mismatch, and reproducible.' : classification === 'HEALTHY' ? 'No automated test failure was detected.' : 'A validation failure occurred, but it must not be called a confirmed regression because one or more regression gates were not satisfied.'}\n\n## Merge Information\n\n- Repository: ${merge.repository.fullName}\n- Pull request: #${merge.pullRequest.number} — ${merge.pullRequest.title}\n- Source branch: ${merge.pullRequest.sourceBranch}\n- Target branch: ${merge.pullRequest.targetBranch}\n- Merge commit: ${merge.pullRequest.mergeCommitSha}\n- Merged by: ${merge.pullRequest.mergedBy}\n- Merged at: ${merge.pullRequest.mergedAt}\n- Pull request description: ${merge.pullRequest.description || '(empty)'}\n\n## Change Summary\n\n${merge.quickSummary}\n\n- Impacted features: ${merge.changes.impactedFeatures.join(', ') || 'not inferred'}\n- Dependency files: ${merge.changes.dependencyFiles.join(', ') || 'none'}\n- Configuration files: ${merge.changes.configurationFiles.join(', ') || 'none'}\n\n| Changed file | Status | Delta |\n|---|---:|---:|\n${changedRows}\n\n## Build Status\n\n- Overall validation: **${statusLabel}**\n- Application build: passed before Playwright execution\n- Test document: ${spec.document.title} (${spec.testCaseId}), completely read: ${spec.document.completelyRead}\n- Runtime base URL source: ${spec.runtime.baseUrlSource}\n- Credential source: ${spec.runtime.credentialsSource}\n\n## Test Summary\n\n- Total: ${first.length}\n- Passed: ${passed.length}\n- Failed: ${failed.length}\n- Skipped: ${skipped.length}\n- Duration: ${(durationMs / 1000).toFixed(2)} seconds\n- Reproduced failures: ${reproduced.length}\n- Flaky/non-reproduced failures: ${flaky.length}\n- Confirmed regressions: ${confirmed.length}\n\n| Test | First run | Reproduction run | Passed in previous successful baseline |\n|---|---:|---:|---:|\n${failureRows}\n\n## Runtime Telemetry\n\n- Browser console errors: ${telemetry.consoleErrors.length}\n- JavaScript exceptions: ${telemetry.javascriptExceptions.length}\n- Network connection failures: ${telemetry.requestFailures.length}\n- HTTP responses observed: ${telemetry.responses.length}\n- Main-frame navigations: ${telemetry.navigations.length}\n\n## Root Cause Analysis\n\n- Introducing merge commit: ${confirmed.length ? merge.pullRequest.mergeCommitSha : 'not assigned because regression gates were not all satisfied'}\n- Severity: ${severity}\n- Risk: ${risk}\n\n### Execution breakpoints\n\n${breaks}\n\n### Files to inspect first\n\n${probable}\n\n### Suggested fixes\n\n1. Reproduce the failing Playwright step locally in the same test environment and inspect the retained trace, screenshot, video, console, and response telemetry.\n2. Start with the ranked files above and restore the documented login request, response handling, navigation, validation message, and error-free console behavior.\n3. If dependencies or configuration changed, verify authentication endpoints, environment values, build-time variables, and version compatibility before changing application logic.\n4. Add or update focused automated coverage only when it remains faithful to ${spec.testCaseId}; do not weaken the documented assertions to make the build pass.\n`;
  fs.writeFileSync(jsonPath('regression-report.md'), report);
  appendSummary(`\n${report}`);

  if (!failed.length) {
    fs.writeFileSync(path.join(baselineDir, 'baseline.json'), `${JSON.stringify({
      repository: EXPECTED_REPOSITORY,
      branch: EXPECTED_BASE_BRANCH,
      sourceRunId: process.env.GITHUB_RUN_ID,
      mergeCommitSha: merge.pullRequest.mergeCommitSha,
      createdAt: new Date().toISOString(),
      passed: passed.map((test) => test.id),
    }, null, 2)}\n`);
  }
  appendOutput('classification', classification);
  appendOutput('regression_detected', confirmed.length > 0 ? 'true' : 'false');
  appendOutput('workflow_failure', failed.length > 0 ? 'true' : 'false');
  appendOutput('healthy', failed.length === 0 ? 'true' : 'false');
}

function stepOutcomes() {
  return ['CHECKOUT', 'SETUP_NODE', 'PREPARE', 'DEPENDENCIES', 'BUILD', 'PLAYWRIGHT', 'START_APP', 'TESTS', 'ANALYZE']
    .map((name) => ({ name: name.toLowerCase(), outcome: process.env[`STEP_${name}`] || 'unknown' }));
}

function infrastructureReport(outcomes) {
  const merge = readJson(jsonPath('merge-details.json'));
  const firstFailure = outcomes.find((step) => step.outcome === 'failure') || outcomes.find((step) => !['success', 'skipped'].includes(step.outcome));
  return `# Post-Merge Regression Report\n\n## Classification\n\n**INFRASTRUCTURE_OR_VALIDATION_FAILURE** — this is not a confirmed application regression because automated regression gates did not complete.\n\n## Merge Information\n\n- Repository: ${merge?.repository?.fullName || process.env.GITHUB_REPOSITORY || 'unavailable'}\n- Pull request: ${merge ? `#${merge.pullRequest.number} — ${merge.pullRequest.title}` : 'unavailable'}\n- Source branch: ${merge?.pullRequest?.sourceBranch || 'unavailable'}\n- Target branch: ${merge?.pullRequest?.targetBranch || EXPECTED_BASE_BRANCH}\n- Merge commit: ${merge?.pullRequest?.mergeCommitSha || process.env.GITHUB_SHA || 'unavailable'}\n- Merged by: ${merge?.pullRequest?.mergedBy || 'unavailable'}\n- Merged at: ${merge?.pullRequest?.mergedAt || 'unavailable'}\n\n## Failure Summary\n\nThe workflow stopped at **${firstFailure?.name || 'unknown'}**. Per the regression policy, no product regression is being claimed.\n\n${outcomes.map((step) => `- ${step.name}: ${step.outcome}`).join('\n')}\n\n## Required Follow-up\n\n1. Open the GitHub Actions run logs and inspect the first failing stage.\n2. Restore access to GitHub metadata, the Google test document, dependencies, the build, the application, Playwright, or required services as indicated by that stage.\n3. Re-run the workflow; only a previously passing, document-confirmed, reproducible Playwright failure may be classified as a regression.\n`;
}

function base64Url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sendGmail(recipient, body) {
  const token = await googleAccessToken();
  const raw = [
    `To: ${recipient}`,
    `Subject: ${SUBJECT}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ].join('\r\n');
  return fetchJson('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: base64Url(raw) }),
  }, 'Gmail send');
}

async function notify() {
  const outcomes = stepOutcomes();
  const infrastructureFailure = outcomes.some((step) => step.outcome === 'failure');
  const analysis = readJson(jsonPath('analysis.json'));
  let report = null;
  if (fs.existsSync(jsonPath('regression-report.md'))) report = fs.readFileSync(jsonPath('regression-report.md'), 'utf8');
  if (infrastructureFailure || !analysis) {
    report = infrastructureReport(outcomes);
    fs.writeFileSync(jsonPath('regression-report.md'), report);
  }
  const classification = infrastructureFailure || !analysis ? 'INFRASTRUCTURE_OR_VALIDATION_FAILURE' : analysis.classification;
  const shouldEmail = infrastructureFailure || !analysis || analysis.workflowFailure;
  if (!shouldEmail) {
    writeJson('notification.json', { sent: false, reason: 'healthy', classification });
    appendOutput('sent', 'false');
    return;
  }
  const merge = readJson(jsonPath('merge-details.json'));
  const recipient = merge?.recipient?.selected || FALLBACK_RECIPIENT;
  const body = `Classification: ${classification}\n\n${report}\n\nGitHub Actions run: ${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}\n`;
  const message = await sendGmail(recipient, body);
  writeJson('notification.json', { sent: true, recipient, subject: SUBJECT, classification, gmailMessageId: message.id, sentAt: new Date().toISOString() });
  appendSummary(`\n## Notification\n\nSent **${SUBJECT}** to **${recipient}**.`);
  appendOutput('sent', 'true');
  appendOutput('recipient', recipient);
}

const command = process.argv[2];
try {
  if (command === 'prepare') await prepare();
  else if (command === 'analyze') analyze();
  else if (command === 'notify') await notify();
  else throw new Error(`Unknown command ${JSON.stringify(command)}. Expected prepare, analyze, or notify.`);
} catch (error) {
  const record = { command, message: error.message, stack: error.stack, at: new Date().toISOString() };
  writeJson(`${command || 'unknown'}-error.json`, record);
  appendSummary(`\n## ${command || 'workflow'} error\n\n\`${error.message}\``);
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
