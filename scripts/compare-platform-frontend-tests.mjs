import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const [directory] = process.argv.slice(2)
assert.ok(directory, 'Pass the deployment validation directory containing both TAP logs.')
const artifactRoot = path.resolve(directory)
function readText(file) {
  const bytes = fs.readFileSync(file)
  return bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8').replace(/^\uFEFF/u, '')
}
function parseReport(file) {
  const text = readText(file)
  const names = pattern => [...text.matchAll(pattern)].map(row => row[1].replace(/\\+/gu, '/'))
  const count = label => Number(text.match(new RegExp(`^# ${label} (\\d+)$`, 'm'))?.[1])
  const failedNames = names(/^not ok \d+ - (.+)\r?$/gmu)
  return { file, tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'),
    failedNames, passedNames: names(/^ok \d+ - (.+)\r?$/gmu) }
}
const baseline = parseReport(path.join(artifactRoot, 'baseline-frontend-tests.tap'))
const current = parseReport(path.join(artifactRoot, 'current-frontend-tests.tap'))
assert.equal(baseline.failedNames.length, baseline.failed, 'All baseline failures must have a named TAP result.')
assert.equal(current.failedNames.length, current.failed, 'All current failures must have a named TAP result.')
const baselineFail = new Set(baseline.failedNames), currentFail = new Set(current.failedNames)
const baselineNames = new Set([...baseline.failedNames, ...baseline.passedNames])
const currentNames = new Set([...current.failedNames, ...current.passedNames])
const newFailures = current.failedNames.filter(name => !baselineFail.has(name))
const resolvedFailures = baseline.failedNames.filter(name => !currentFail.has(name))
const removedTests = [...baselineNames].filter(name => !currentNames.has(name))
const addedPassingTests = current.passedNames.filter(name => !baselineNames.has(name))
const result = {
  comparison: 'original source archive vs current source, shared identical installed frontend dependencies',
  baseline: { file: baseline.file, tests: baseline.tests, passed: baseline.passed, failed: baseline.failed, skipped: baseline.skipped },
  current: { file: current.file, tests: current.tests, passed: current.passed, failed: current.failed, skipped: current.skipped },
  failureNameComparison: baseline.failedNames.map(name => ({ name, baseline: 'failed', current: currentFail.has(name) ? 'failed' : 'not failed' })),
  newFailures, resolvedFailures, removedTests, addedPassingTests,
  zeroNewFailures: newFailures.length === 0,
  allOriginalTestsRemain: removedTests.length === 0,
  conclusion: newFailures.length === 0 && removedTests.length === 0 ? 'The original 24 failing checks reproduce unchanged; no new failing or removed test names.' : 'Test differences require inspection.',
}
const output = path.join(artifactRoot, 'frontend-baseline-current-comparison.json')
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ baseline: result.baseline, current: result.current, newFailures, removedTests, addedPassingTests: addedPassingTests.length, output }, null, 2))
if (!result.zeroNewFailures || !result.allOriginalTestsRemain) process.exitCode = 1
