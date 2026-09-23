#!/bin/bash
# End-to-end fine-tune of qwen3-8b on the Mise scheduling skill.
#
# HEAVY JOB — read README.md first. Needs: mlx-lm, llama.cpp (for GGUF), a ~16GB
# base-model download on first run, and 1–3 hours of GPU time. Run it with the
# app IDLE: Ollama serving the live app AND a 16k-seq LoRA train both want the
# GPU/RAM, and together they'll thrash 64GB.
set -euo pipefail
cd "$(dirname "$0")"

MODEL="Qwen/Qwen3-8B"
: "${LLAMA_CPP:?set LLAMA_CPP to your llama.cpp checkout (for convert_hf_to_gguf.py + llama-quantize)}"

echo "==> 1/6  deps"
python3 -m pip install -U mlx-lm

echo "==> 2/6  (re)generate the dataset from the CURRENT tools + prompt"
# Keeps the training data in lockstep with the app: if the tools or SYSTEM_PROMPT
# changed, regenerate so the model learns the real thing.
bun gen-training-data.mjs

echo "==> 3/6  LoRA train (auto-downloads $MODEL the first time; hours)"
mlx_lm.lora --config lora-config.yaml

echo "==> 4/6  fuse adapters into a standalone model"
mlx_lm.fuse --model "$MODEL" --adapter-path ./adapters --save-path ./fused

echo "==> 5/6  convert to GGUF + quantize for Ollama"
python3 "$LLAMA_CPP/convert_hf_to_gguf.py" ./fused --outfile ./mise-8b-f16.gguf
"$LLAMA_CPP/build/bin/llama-quantize" ./mise-8b-f16.gguf ./mise-8b.gguf Q5_K_M

echo "==> 6/6  import into Ollama"
# The Modelfile reuses qwen3:8b's tool-calling template (see README step 6).
ollama create mise-8b -f Modelfile

cat <<'EOF'

Done. Now GATE it before adopting — do NOT just switch:
  1) point the eval at it:   MISE_MODEL=mise-8b  (start a test server on that model)
  2) run the Phase-3 harness (scratchpad eval-harness.mjs) against it
  3) adopt (set MISE_MODEL=mise-8b) ONLY if it beats stock qwen3:8b on wall-clock
     AND holds tool-accuracy vs the 30B. Otherwise keep qwen3:30b-a3b.
EOF
