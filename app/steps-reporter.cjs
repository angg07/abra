// Tiny reporter for replays: prints each user-visible action as one JSON line so the app can
// caption the live view and build the PDF guide. Lines start with "@@STEP " to separate them from the list output.
const KEEP = new Set(['pw:api', 'expect', 'test.step']);
class StepsReporter {
  onTestBegin(test) {
    process.stdout.write(`@@STEP ${JSON.stringify({ title: test.title, category: 'test', test: test.title })}\n`);
  }
  onStepBegin(test, result, step) {
    if (!KEEP.has(step.category)) return;
    if (step.parent && step.parent.category !== 'test.step') return; // skip internals of an action/assertion
    const { file, line } = step.location ?? {};
    process.stdout.write(`@@STEP ${JSON.stringify({ title: step.title, category: step.category, test: test.title, file, line })}\n`);
  }
  printsToStdio() { return false; }
}
module.exports = StepsReporter;
