#!/usr/bin/env bash
# Mise setup — Ollama models + Tailscale check. (SPEC §1)
set -euo pipefail

echo "── Ollama ──────────────────────────────────────────"
if ! command -v ollama >/dev/null 2>&1; then
  echo "✗ ollama not installed — https://ollama.com/download" >&2
  exit 1
fi

# Ollama must listen on localhost only; the API server is the only consumer.
# Default is fine. Do NOT set OLLAMA_HOST=0.0.0.0 — nothing outside the box
# should reach the model directly.
if [ "${OLLAMA_HOST:-}" != "" ] && [ "${OLLAMA_HOST:-}" != "127.0.0.1"* ]; then
  echo "⚠ OLLAMA_HOST is set to '${OLLAMA_HOST}'. Unset it — Ollama should stay on 127.0.0.1."
fi

if ! curl -sf --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null; then
  echo "✗ Ollama isn't running. Start the Ollama app (or 'ollama serve') and re-run." >&2
  exit 1
fi

echo "Pulling models…"
ollama pull qwen3:8b            # primary — strong tool calling, ~5GB
ollama pull qwen2.5vl:7b        # vision — reads a photo of your class schedule, ~6GB
ollama pull qwen3:30b-a3b || echo "⚠ optional fallback model skipped"

echo
echo "── Database ────────────────────────────────────────"
export PATH="$HOME/.bun/bin:$PATH"
bun install
echo "✓ deps installed; migrations run automatically on first DB open"

echo
echo "── Tailscale ───────────────────────────────────────"
TS_BIN="tailscale"
if ! command -v tailscale >/dev/null 2>&1; then
  TS_BIN="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
fi
if [ -x "$TS_BIN" ] || command -v "$TS_BIN" >/dev/null 2>&1; then
  "$TS_BIN" status || echo "⚠ tailnet not up — open the Tailscale app and sign in."
  HOSTNAME=$("$TS_BIN" status --json 2>/dev/null | bun -e '
    const chunks = [];
    for await (const c of Bun.stdin.stream()) chunks.push(c);
    try {
      const s = JSON.parse(Buffer.concat(chunks).toString());
      const dns = s.Self?.DNSName?.replace(/\.$/, "");
      if (dns) console.log(dns);
    } catch {}' || true)
  if [ -n "${HOSTNAME:-}" ]; then
    echo
    echo "✓ Reach Mise from your MacBook / iPhone at:"
    echo "    http://${HOSTNAME}:3000"
  fi
else
  echo "⚠ Tailscale not installed — https://tailscale.com/download. The app still works locally at http://localhost:3000."
fi

echo
echo "Done. Start everything with: bun dev   (UI :3000, API :3001)"
