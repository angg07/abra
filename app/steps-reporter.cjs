// Tiny reporter for replays: prints each user-visible action as one JSON line so the app can
// caption the live view and build the PDF guide. Lines start with "@@STEP " to separate them from the list output.
const KEEP = new Set(['pw:api', 'expect', 'test.step']);
class StepsReporter {
  // the run page's "Test X of Y": every test() in every file, times its repeats and data rows
  onBegin(config, suite) { process.stdout.write(`@@STEP ${JSON.stringify({ category: 'plan', total: suite.allTests().length })}\n`); }
  onTestBegin(test) {
    process.stdout.write(`@@STEP ${JSON.stringify({ title: test.title, category: 'test', test: test.title })}\n`);
  }
  onStepBegin(test, result, step) {
    if (!KEEP.has(step.category)) return;
    if (step.parent && step.parent.category !== 'test.step') return; // skip internals of an action/assertion
    const { file, line } = step.location ?? {};
    process.stdout.write(`@@STEP ${JSON.stringify({ title: step.title, category: step.category, test: test.title, file, line })}\n`);
  }
  // a test's own result, in the order tests ran (the JSON report groups repeats by test instead)
  onTestEnd(test, result) { process.stdout.write(`@@STEP ${JSON.stringify({ category: 'test-end', status: result.status })}\n`); }
  printsToStdio() { return false; }
}
module.exports = StepsReporter;
