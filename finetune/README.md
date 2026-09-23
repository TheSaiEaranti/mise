# Fine-tuning (Phase 4)

Teach a **small, fast** local model (qwen3-8b) the Mise scheduling skill, so it
matches the 30B's tool-accuracy while being cheaper per round-trip — locking in
speed without losing correctness.

## Why this, and why 8B

Phase 3's eval (`../` scratchpad `eval-harness.mjs`) measured, on 16 stratified
cases:

| model | tool-accuracy | mean | p90 | worst |
|---|---|---|---|---|
| qwen3:30b-a3b (current) | 88% | 47s | 93s | 93s |
| qwen3:8b (stock) | 94% | 76s | 175s | 264s |

Stock 8B is **more accurate but slower** — it burns extra round-trips to land an
answer, and it's flaky on casual phrasing only sometimes. Fine-tuning targets
exactly that: make the 8B emit the **right tool + args first try**, which cuts
the round-trips → reliable **and** fast. This is a bet, so it's **gated by the
eval** (below) — we only adopt the tuned model if it actually wins.

## The data pipeline (the important part — already built)

`gen-training-data.mjs` generates training pairs and **auto-labels every one by
running the real tool as the oracle**: it builds a scenario in an in-memory DB,
computes the correct tool args from the actual events, runs `tool.run(args,
'dry')`, and keeps the example only if it's actionable with no blocking conflict.
So a bad label can't enter the set — the oracle rejects it (it caught 29 on the
first run). Each example carries the **real inference prompt** (SYSTEM_PROMPT +
schedule context + all tool schemas), so training matches serving exactly.

Re-run it any time the tools or prompt change — the data stays in lockstep:

```bash
bun gen-training-data.mjs      # → data/train.jsonl + data/valid.jsonl
```

Current pilot: **242 verified examples**, weighted ~38% to `fit_in_event` (the
casual-phrasing case the 30B is flaky on) plus negatives (ask-to-clarify, plain
answers) so it learns when NOT to fire a tool. **Scale to ~1–2k for a real run**
by raising the per-intent counts in the generator.

## Running the training (HEAVY — do this with the app idle)

Prereqs: `mlx-lm` (pip), a `llama.cpp` checkout for GGUF (`export LLAMA_CPP=…`),
~16GB free for the base-model download, and **1–3 hours** of GPU time. Ollama
serving the live app AND a 16k-seq LoRA train will thrash 64GB together — stop
using the app while it runs.

```bash
export LLAMA_CPP=/path/to/llama.cpp
./run.sh
```

Steps (see `run.sh`): deps → regen data → `mlx_lm.lora` (config in
`lora-config.yaml`) → `mlx_lm.fuse` → convert to GGUF + quantize Q5_K_M →
`ollama create mise-8b -f Modelfile`. The Modelfile reuses qwen3:8b's exact
tool-calling template.

Why 16k `max_seq_length`: each example ≈ 14.4k tokens (the full prompt), so
training must see it all or it truncates the tools away. That long sequence is
the whole memory cost — hence `grad_checkpoint` + `batch_size 1`.

## The gate — do NOT just switch

After building `mise-8b`, run the Phase-3 eval against it (`MISE_MODEL=mise-8b`
on a test server). **Adopt it (set `MISE_MODEL=mise-8b`) only if it beats stock
qwen3:8b on wall-clock AND holds tool-accuracy vs the 30B.** Otherwise keep
qwen3:30b-a3b. The eval decides, not the hope.

## Artifacts (large, not for version control)

`data/`, `adapters/`, `fused/`, `*.gguf` are build outputs — regenerate them,
don't commit them. `gen-training-data.mjs`, `lora-config.yaml`, `run.sh`,
`Modelfile`, and this README are the durable pieces.
