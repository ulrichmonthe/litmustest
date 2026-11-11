// Dashboard commands a glossary next step may name as `action`. The dashboard runs each with the same handler as the
// page's own button (docs/stories/explainer.md E3-S3); this list is what the validator accepts.
export const ACTIONS: Record<string, string> = {
  "pending.commit": "Commit the pending changes to the current branch",
  "pending.openPr": "Open a pull request for the pending changes",
  "pending.discard": "Discard the pending changes",
  "judges.runDev": "Run the judge on its dev set",
  "judges.runTest": "Run the judge on its test set, once",
  "review.openBatch": "Open the review queue on the latest batch",
  "tasks.graduate": "Graduate the tasks that are ready",
};
