# Evaluation results

Precedent's model-backed steps are scored against labelled datasets in [`eval/datasets`](../eval/datasets). Every number here can be reproduced on a development install: **Apps → Decision register → Run evaluation**.

## Results

Three consecutive runs on 8 November 2026 produced identical results on every metric. All model calls run at temperature 0, so this shows the results are reproducible. It is not a measure of sampling variance.

| Metric | Tuning set | Held-out set |
|---|---|---|
| Decision extraction precision | 100% (24 cases) | **100%** (21 cases) |
| Decision extraction recall | 100% | **100%** |
| Rejected alternatives recovered | 100% | **83.3%** |
| Assumptions recovered | 100% | **100%** |
| Contradictions caught | 100% | **100%** |
| False alarm rate | 1.6% (1 of 64 pairs) | **0%** (0 of 67) |
| Agreement on ambiguous pairs | — | **100%** |
| Free triage gate: decisions kept | 100% | **90.9%** |

The **held-out set** was written after the prompts and has never been used to tune them. It is the better estimate of real-world performance, and it is reported as measurements rather than gated by thresholds.

## What the numbers do not show

Stated plainly, because a perfect score on a small dataset invites the wrong conclusion.

- **The datasets are small.** 36 tuning and 36 held-out cases is enough to catch regressions and gross failures. It is not enough to claim a precise accuracy for production use.
- **The datasets were written by the developer.** They are not drawn from real customer threads.
- **The free triage gate misses some colloquial decisions.** "Okay, we've gone back and forth enough. Porto it is." never reaches the model. The gate is a regular-expression cost filter, not a classifier, and patching it against held-out cases would only turn them into tuning cases. Anything it misses can still be recorded by asking the Precedent agent to "record this decision", which goes through the same grounding and human confirmation.
- **One tuning-set false alarm is arguably correct.** "Order new laptops for the support team" was linked to "expense reports over $5,000 require CFO approval". A team's laptop order plausibly exceeds that limit. The case was labelled unrelated before the run, and it stays labelled that way. Relabelling after seeing a model answer is tuning.
- **One held-out field miss is arguably a labelling problem.** In "Berlin is approved… we're skipping Paris", Paris may be a separate decision rather than a rejected alternative to Berlin.

## Changes informed by held-out results

Two held-out cases exposed defects, and the fixes addressed the class of problem rather than the individual case. Both cases are recorded as `tuningExposure` in their dataset files, and fresh unseen cases of the same kind were added to re-measure.

1. **Conflict recall.** A word-overlap filter decided which past decisions the model could see, so a paraphrased conflict ("have the lawyers mark up each supplier's own paperwork") never reached it. Word overlap now only ranks candidates, and the whole register is sent when it fits the budget. Three new paraphrase cases, written after the fix, were all caught. The cost: the model now sees every decision for every proposal, which produced the one tuning-set false alarm above.
2. **Triage gate.** Added patterns for colloquial settlements ("that's settled", "ship it", "fine, X it is"). Of the new unseen cases, one ("Porto it is") is still missed, and it is reported rather than patched.
