#!/bin/bash
# One unattended long run: train to iter-900 on the diverse+format-fixed data,
# then fuse and gate-eval the result. Writes a summary to long-result.txt.
set -e
export PATH="$HOME/.bun/bin:$PATH"
cd "$(dirname "$0")"
SNAP=$(ls -d ~/.cache/huggingface/hub/models--Qwen--Qwen3-8B/snapshots/*/ | head -1)

echo "[$(date +%H:%M)] training to iter-900..." > long-result.txt
rm -rf adapters
.venv/bin/python -m mlx_lm lora --config lora-config.yaml --model "$SNAP" > train-long.log 2>&1

echo "[$(date +%H:%M)] val-loss trajectory:" >> long-result.txt
grep -oE "Iter [0-9]+: Val loss [0-9.]+" train-long.log >> long-result.txt

echo "[$(date +%H:%M)] fusing iter-900..." >> long-result.txt
rm -rf fused
.venv/bin/python -m mlx_lm fuse --model "$SNAP" --adapter-path ./adapters --save-path ./fused >> train-long.log 2>&1

echo "[$(date +%H:%M)] serving + gate eval..." >> long-result.txt
.venv/bin/python -m mlx_lm server --model ./fused --port 8081 > server-long.log 2>&1 &
SPID=$!
for i in $(seq 1 40); do curl -s localhost:8081/v1/models >/dev/null 2>&1 && break; sleep 2; done
# Run the eval 3x to average out the non-determinism we care about.
for run in 1 2 3; do
  echo "--- eval run $run ---" >> long-result.txt
  bun eval-tuned.mjs 2>&1 | grep -E "FINE-TUNED|✗" >> long-result.txt
done
kill $SPID 2>/dev/null || true
echo "[$(date +%H:%M)] LONG RUN COMPLETE" >> long-result.txt
