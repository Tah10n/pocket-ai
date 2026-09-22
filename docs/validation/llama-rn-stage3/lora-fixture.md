# LoRA acceptance fixture

The [pinned manifest](lora-fixture.json) reuses the 144,811,552-byte SmolLM2-135M
Instruct Q8_0 base from the [stage 2 acceptance](../../llama-rn-013-stage2-acceptance.md)
and adds a 4,899,520-byte BehaviorTree adapter. Published repository revisions,
file sizes and SHA-256 values were checked against Hugging Face metadata on
2026-09-22. Weights are not included in the repository.

**Native acceptance: `not_run`.** Published metadata is a candidate selection,
not proof that the adapter loads or changes the model. No native compatibility,
nonzero tensor effect, output quality, GPU, iOS or MTP result is claimed here.

## Sources and conditions

- [Pinned base repository](https://huggingface.co/Mungert/SmolLM2-135M-Instruct-GGUF/tree/980b4318b34b2f20e60c89d8f8a98283ec83cbd6)
  declares Apache-2.0. Its README identifies the Instruct checkpoint; its
  `base_model` card metadata names the underlying non-Instruct family. Inspect
  the actual model identity when preparing the fixture.
- [Pinned adapter repository](https://huggingface.co/unileon-robotics/SmolLM2-135M-Instruct-BehaviorTree-LoRA-GGUF/tree/e211f41133cf7c6da0ae80b3a08f0ffbfd0653e9)
  declares Apache-2.0, the Instruct base and an adapter relationship. Hugging Face
  reports architecture `llama` and 2,442,240 adapter parameters. Its card contains
  no training hyperparameters, original base revision or evaluation results.
- The declared training dataset,
  [LLM_BRAIn_dataset](https://huggingface.co/datasets/ArtemLykov/LLM_BRAIn_dataset/tree/7887242340a94db90d77b387db286acdd2afec12),
  is licensed CC-BY-4.0 and attributed to Artem Lykov and Dzmitry Tsetserukou.
  Their [LLM-BRAIn paper](https://arxiv.org/abs/2305.19352) describes behavior-tree
  generation. Its results concern their own model, not this SmolLM2 adapter.

Preserve applicable license and attribution notices when redistributing artifacts
or dataset material. This fixture protocol does not redistribute either. Use the
existing artifact download and integrity-check path; do not add a downloader or
train an adapter for acceptance.

## Controlled native probe

Run the stage 1 and 2 inference pack first on the new isolated Android CPU QA
binary. Record source and installed APK identities separately from model identities.
Verify the pinned model and adapter bytes before binding the adapter to the base
variant. A compatible name or an existing local file is insufficient.

Use one fixed robot behavior-tree instruction with a short, explicit set of
available nodes, consistent with the declared task. Freeze the formatted prompt,
template parameters and generation configuration for every comparison. Do not use
a grammar that forces the expected behavior-tree output.

1. Measure the first generated token twice without LoRA, with the manifest's fixed
   sampling settings and `n_probs: 10`. Retain only bounded probabilities in memory
   and measure repeat-baseline numerical variation.
2. Apply scale `1` through the production lifecycle, inspect the native loaded list,
   and measure the same first-token distribution. Run a bounded completion.
3. Change the scale to `0.5`, inspect the list, repeat the distribution comparison
   and run another bounded completion.
4. Remove all adapters, inspect the empty loaded list, repeat the baseline measurement
   and run a completion. Require restoration within measured numerical variation.
5. Restore scale `1`, run A+LoRA -> embedding B -> A, and verify the same adapter
   identity, scale and effective load profile before another response. Check that
   deleting the applied adapter is rejected while unrelated artifact deletion works.

Compare the first-token distributions, before generated histories diverge. Use the
union of observed token identities and report missing top-10 entries as censored
values, not known zero probability. Record common-token probability deltas,
top-10 membership changes and baseline variability separately. A numerical change
must exceed the observed baseline variation; randomly different generated text or
a loaded-list entry alone does not demonstrate application. Do not report a full
distribution distance from truncated top-10 data. If no meaningful effect appears,
report that result and investigate the fixture rather than declaring success.

Temperature is `1`, not `0`: the pinned runtime documents that zero temperature
disables probability output. Keep caches invalidated consistently between adapter
configurations. Never begin another operation merely because a deadline expires.

Evidence should contain identities, loaded-state checks, bounded numerical
measurements, timings and pass/fail/not_run statuses. Exclude prompts, generated
content, schemas, templates, private paths and raw native errors. Preserve the
failure category and the concrete blocker for every unexecuted scenario.
