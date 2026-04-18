#!/usr/bin/env python3
"""
ACP×CLI×PCC — 3大AIクリティック統合パイプライン

PCC 制約注入 × マルチランタイム (Gemini CLI / Claude Code / Copilot CLI) で
AI の本気を引き出す critic パイプライン。

Usage:
  pcc-critic "semantic_delta の弱点を指摘しろ"
  pcc-critic --runtime copilot --model gpt-5-mini --preset 探 "設計を分析しろ"
  pcc-critic --runtime claude --model claude-opus "この設計をレビューしろ"
  pcc-critic --preset 極 "このコードをレビューしろ"
  pcc-critic --preset 探,監,刃 "この変更を単発で厚くレビューしろ"
  pcc-critic --preset all --model fast "この設計を多層で検証しろ"
  cat code.py | pcc-critic --preset 極 "このコードの問題点は？"

Runtimes: gemini (default), claude, copilot

PCC Presets:
  探 (#探) — 批判的探索。多角的視点、前提への挑戦、弱点指摘（デフォルト）
  極 (#極) — 極限精度。無駄ゼロ、聞かれたことだけ答える
  均 (#均) — バランス型。批判と提案を均等に
  監 (#監) — 監査特化。diff/test/evidence ベースの判定
  刃 (#刃) — 実装設計レビュー。3案比較+構造化出力
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time

# ─── PCC Presets ─────────────────────────────────────────────────────────────

PCC_PRESETS = {
    "探": {
        "label": "#探 (Critical Explorer)",
        "constraints": [
            "Explore multiple perspectives and challenge all assumptions",
            "Identify specific weaknesses with concrete reasoning",
            "Do NOT be agreeable — be a constructive critic",
            "Support each point with examples or scenarios",
            "If there are no weaknesses, say so explicitly — do not fabricate",
        ],
    },
    "極": {
        "label": "#極 (Maximum Precision)",
        "constraints": [
            "Be extremely concise — no filler, no pleasantries",
            "Answer only what is asked, nothing more",
            "Use structured output (numbered lists, tables)",
            "If you cannot answer precisely, state why",
        ],
    },
    "均": {
        "label": "#均 (Balanced Review)",
        "constraints": [
            "Provide equal weight to strengths and weaknesses",
            "For each weakness, suggest a concrete improvement",
            "Be honest but constructive",
            "Prioritize actionable feedback over theoretical concerns",
        ],
    },
    "監": {
        "label": "#監 (Audit Mode)",
        "constraints": [
            "Evaluate based on evidence only: diff, tests, logs, exit codes",
            "Ignore natural language self-reports of success",
            "Classify result as: PASS / NEEDS_EVIDENCE / NO_OP / FAIL",
            "If no evidence is provided, verdict is NEEDS_EVIDENCE",
            "State exactly what evidence is missing",
        ],
    },
    "刃": {
        "label": "#刃 (Blade — Implementation Reviewer)",
        "constraints": [
            "You are a strict implementation designer and code reviewer",
            "First examine related files and existing implementation — judge based on facts only",
            "Never assert unverified claims. Mark guesses explicitly as 'Assumption'",
            "Do NOT stop at one option — compare at least 3 alternatives",
            "For each alternative, output: changes / blast radius / risks / test focus / likely failure points",
            "Recommend the safest option with clear justification",
            "Before saying 'done', present the actual evidence you verified",
            "If information is missing, state a reasonable assumption and proceed",
            "No verbose preamble. Output at maximum density",
        ],
        "output_format": """Output format (MANDATORY):
1. 結論 (Conclusion)
2. 現状理解 (Current Understanding)
3. 代替案 A / B / C (Alternatives with tradeoffs)
4. 推奨案 (Recommendation + reasoning)
5. 実装手順 (Implementation steps)
6. テスト観点 (Test perspectives)
7. 残る不確実性 (Remaining uncertainties)""",
    },
}

PRESET_ALIASES = {
    "all": ["探", "極", "均", "監", "刃"],
    "full": ["探", "極", "均", "監", "刃"],
    "5mode": ["探", "極", "均", "監", "刃"],
    "layered": ["探", "極", "均", "監", "刃"],
}


# ─── Routing Table ───────────────────────────────────────────────────────────

MODEL_ROUTING = {
    # Gemini
    "fast":   "gemini-3.1-flash-lite-preview",
    "standard": "gemini-3-flash-preview",
    "plan":   "gemini-3.1-pro-preview",
    "deep":   "gemini-3.1-pro-preview",
    # Claude
    "claude-sonnet": "claude-sonnet-4-6",
    "claude-opus":   "claude-opus-4-6",
    # Copilot
    "copilot-mini":   "gpt-5-mini",
    "copilot-pro":    "gpt-5.2",
    "copilot-sonnet": "claude-sonnet-4",
    "copilot-gemini": "gemini-3-flash",
}


def load_model_routing() -> dict:
    """~/.pcc-critic.json から MODEL_ROUTING を上書きロードする"""
    config_path = pathlib.Path.home() / ".pcc-critic.json"
    if not config_path.exists():
        return dict(MODEL_ROUTING)
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            user_config = json.load(f)
        if isinstance(user_config.get("model_routing"), dict):
            merged = dict(MODEL_ROUTING)
            merged.update(user_config["model_routing"])
            return merged
    except (json.JSONDecodeError, OSError) as e:
        print(f"[ACP×CLI×PCC] Warning: ~/.pcc-critic.json の読み込みに失敗: {e}", file=sys.stderr)
    return dict(MODEL_ROUTING)

# ─── Core ────────────────────────────────────────────────────────────────────

def normalize_preset_spec(preset_spec: str) -> list[str]:
    """単一 preset / カンマ区切り / alias を正規化する"""
    spec = (preset_spec or "探").strip()
    if not spec:
        return ["探"]

    raw_tokens = []
    for chunk in spec.replace("+", ",").split(","):
        token = chunk.strip()
        if not token:
            continue
        raw_tokens.append(token)

    expanded: list[str] = []
    for token in raw_tokens or ["探"]:
        alias = PRESET_ALIASES.get(token.lower())
        if alias:
            expanded.extend(alias)
            continue
        if token not in PCC_PRESETS:
            valid = ", ".join(list(PCC_PRESETS.keys()) + list(PRESET_ALIASES.keys()))
            raise ValueError(f"Unknown preset '{token}'. Valid presets: {valid}")
        expanded.append(token)

    deduped: list[str] = []
    seen = set()
    for preset in expanded:
        if preset not in seen:
            seen.add(preset)
            deduped.append(preset)
    return deduped or ["探"]


def inject_multi_pcc(prompt: str, presets: list[str], runtime: str) -> str:
    """単発ランタイム向けに複数 preset を1リクエストへ束ねる"""
    header = " + ".join(f"#{preset}" for preset in presets)
    pass_blocks = []
    for index, preset in enumerate(presets, start=1):
        config = PCC_PRESETS[preset]
        constraints = "\n".join(f"    - {constraint}" for constraint in config["constraints"])
        output_fmt = config.get("output_format")
        output_hint = f"\n    - Output bias: {output_fmt}" if output_fmt else ""
        pass_blocks.append(
            f"""{index}. {config['label']}
{constraints}{output_hint}"""
        )

    runtime_strategy = [
        "This is a single-request execution. Perform every mode pass within one completion.",
        "Build one shared fact base first, then run each mode against the same facts.",
        "Do not ask for a follow-up turn unless the task is impossible without external data.",
        "If modes disagree, surface the disagreement explicitly instead of hiding it.",
    ]
    if runtime == "gemini":
        runtime_strategy.append(
            "Optimize for one-shot depth: reuse the same context across all passes and spend tokens on synthesis, not repetition."
        )

    runtime_block = "\n".join(f"  - {line}" for line in runtime_strategy)
    mode_block = "\n\n".join(pass_blocks)

    return f"""[PCC Protocol Bundle: {header}]
Single-shot runtime strategy:
{runtime_block}

Task:
{prompt}

Mode passes (execute all):
{mode_block}

Global synthesis rules:
  - Shared facts/evidence must be stated once and reused across all mode passes.
  - Distinguish confirmed evidence from assumptions.
  - Keep the audit conservative when evidence is missing.
  - Final recommendation must cite which modes support it.
  - Prefer dense output over conversational filler.

Output format (MANDATORY):
1. 共通事実 (Shared facts / evidence)
2. モード別分析
   - 探
   - 極
   - 均
   - 監
   - 刃
3. 一致点 (Consensus)
4. 相違点 (Disagreements)
5. 最終推奨 (Final recommendation)
6. 不足証拠 / 次アクション (Missing evidence / next action)
"""

def inject_pcc(prompt: str, presets: list[str], runtime: str) -> str:
    """PCC 制約プロトコルを prompt に注入する"""
    if len(presets) > 1:
        return inject_multi_pcc(prompt, presets, runtime)

    preset = presets[0]
    config = PCC_PRESETS[preset]

    constraints = "\n".join(f"  - {c}" for c in config["constraints"])
    output_fmt = config.get("output_format", "")
    fmt_block = f"\n\n{output_fmt}" if output_fmt else ""

    return f"""[PCC Protocol: {config['label']}]
Constraints:
{constraints}
{fmt_block}
---
{prompt}"""


def _prepend_path(env: dict, entries: list[str]) -> None:
    """PATH に既存順序を保ったまま候補を前置する"""
    current = [part for part in env.get("PATH", "").split(os.pathsep) if part]
    merged = []
    seen = set()
    for path in entries + current:
        if path and path not in seen:
            seen.add(path)
            merged.append(path)
    env["PATH"] = os.pathsep.join(merged)


def _resolve_nvm_bin(bin_name: str) -> str | None:
    """nvm 管理下にある実行ファイルを静かに探索する"""
    nvm_sh = pathlib.Path.home() / ".nvm" / "nvm.sh"
    if not nvm_sh.exists():
        return None
    try:
        probe = subprocess.run(
            [
                "bash",
                "-lc",
                f"source '{nvm_sh}' >/dev/null 2>&1 && command -v {bin_name}",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=os.path.expanduser("~"),
        )
    except (OSError, subprocess.SubprocessError):
        return None
    candidate = probe.stdout.strip().splitlines()
    return candidate[-1] if probe.returncode == 0 and candidate else None


def _resolve_gemini_runtime() -> tuple[dict, str]:
    """Gemini CLI 実行に使う env と binary を解決する"""
    env = os.environ.copy()
    homebrew_candidates = ["/opt/homebrew/bin", "/usr/local/bin"]
    _prepend_path(env, [path for path in homebrew_candidates if os.path.isdir(path)])

    explicit_bin = env.get("GEMINI_BIN", "").strip()
    if explicit_bin:
        gemini_bin = explicit_bin
    else:
        gemini_bin = shutil.which("gemini", path=env.get("PATH"))

    if gemini_bin:
        return env, gemini_bin

    nvm_node = _resolve_nvm_bin("node")
    nvm_gemini = _resolve_nvm_bin("gemini")
    extra_entries = []
    if nvm_node:
        extra_entries.append(os.path.dirname(nvm_node))
    if nvm_gemini:
        extra_entries.append(os.path.dirname(nvm_gemini))
        gemini_bin = nvm_gemini
    if extra_entries:
        _prepend_path(env, extra_entries)

    return env, gemini_bin or "gemini"


def run_gemini(enriched_prompt: str, model: str, timeout: int = 120) -> dict:
    """Gemini CLI headless で実行し結果を返す"""
    env, gemini_bin = _resolve_gemini_runtime()

    t0 = time.monotonic()
    try:
        result = subprocess.run(
            [gemini_bin, '-p', enriched_prompt, '-m', model],
            capture_output=True, text=True, env=env, timeout=timeout,
            cwd=os.path.expanduser("~"),
        )
        elapsed = time.monotonic() - t0
        return {
            "text": result.stdout.strip() or result.stderr.strip(),
            "exit_code": result.returncode,
            "elapsed": round(elapsed, 1),
            "model": model,
        }
    except subprocess.TimeoutExpired:
        return {
            "text": "",
            "exit_code": -1,
            "elapsed": timeout,
            "model": model,
            "error": "TIMEOUT",
        }


def run_claude(enriched_prompt: str, model: str, timeout: int = 120) -> dict:
    """Claude Code CLI (claude -p) で実行し結果を返す"""
    claude_bin = "claude"

    t0 = time.monotonic()
    try:
        result = subprocess.run(
            [claude_bin, '-p', '--model', model, enriched_prompt],
            capture_output=True, text=True, timeout=timeout,
            cwd=os.path.expanduser("~"),
        )
        elapsed = time.monotonic() - t0
        return {
            "text": result.stdout.strip() or result.stderr.strip(),
            "exit_code": result.returncode,
            "elapsed": round(elapsed, 1),
            "model": model,
        }
    except subprocess.TimeoutExpired:
        return {
            "text": "",
            "exit_code": -1,
            "elapsed": timeout,
            "model": model,
            "error": "TIMEOUT",
        }
    except FileNotFoundError:
        return {
            "text": "Error: claude CLI not found. Install Claude Code first.",
            "exit_code": -1,
            "elapsed": 0,
            "model": model,
            "error": "NOT_FOUND",
        }


def run_copilot(enriched_prompt: str, model: str, timeout: int = 120) -> dict:
    """Copilot CLI (copilot -p) で実行し結果を返す"""
    copilot_bin = "copilot"

    t0 = time.monotonic()
    try:
        result = subprocess.run(
            [
                copilot_bin,
                '--model', model,
                '-p', enriched_prompt,
                '-s',
                '--no-custom-instructions',
                '--no-auto-update',
            ],
            capture_output=True, text=True, timeout=timeout,
            cwd=os.path.expanduser("~"),
        )
        elapsed = time.monotonic() - t0
        return {
            "text": result.stdout.strip() or result.stderr.strip(),
            "exit_code": result.returncode,
            "elapsed": round(elapsed, 1),
            "model": model,
        }
    except subprocess.TimeoutExpired:
        return {
            "text": "",
            "exit_code": -1,
            "elapsed": timeout,
            "model": model,
            "error": "TIMEOUT",
        }
    except FileNotFoundError:
        return {
            "text": "Error: copilot CLI not found. Install GitHub Copilot CLI first.",
            "exit_code": -1,
            "elapsed": 0,
            "model": model,
            "error": "NOT_FOUND",
        }


def audit_response(text: str) -> dict:
    """応答の品質を監査する"""
    if not text or len(text.strip()) < 20:
        return {"verdict": "NO_OP", "sycophancy": 0.0, "evidence_count": 0, "words": 0}

    lower = text.lower()
    words = len(text.split())

    # 迎合検知
    syc_markers = [
        "great question", "excellent point", "absolutely right",
        "wonderful", "that's a great idea", "you're absolutely",
        "brilliant", "i love this",
    ]
    syc = sum(1 for m in syc_markers if m in lower) / 3.0

    # evidence 検知（批判的内容の指標）
    ev_markers = [
        "however", "risk", "weakness", "problem", "flaw",
        "limitation", "because", "specifically", "example",
        "breaking", "failure", "impossible", "incorrect",
        "矛盾", "欠陥", "弱点", "問題", "不可能", "破綻", "危険",
    ]
    evidence = sum(1 for m in ev_markers if m in lower)

    if syc > 0.5:
        verdict = "SYCOPHANTIC"
    elif evidence >= 3:
        verdict = "PASS"
    elif evidence >= 1:
        verdict = "REVIEW"
    elif words < 50:
        verdict = "NO_OP"
    else:
        verdict = "NEEDS_EVIDENCE"

    return {
        "verdict": verdict,
        "sycophancy": round(min(syc, 1.0), 2),
        "evidence_count": evidence,
        "words": words,
    }


def main():
    # UTF-8 互換性: LANG=C 環境でも安全に日本語出力
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(
        description="ACP×CLI×PCC — 3大AIクリティック統合パイプライン",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Presets:
  探  批判的探索（デフォルト）
  極  極限精度
  均  バランス型
  監  監査特化
  刃  実装設計レビュー（3案比較+構造化出力）

Runtimes:
  gemini   Gemini CLI (default)
  claude   Claude Code CLI
  copilot  GitHub Copilot CLI

Models:
  fast           gemini-3.1-flash-lite-preview
  standard       gemini-3-flash-preview
  plan           gemini-3.1-pro-preview
  deep           gemini-3.1-pro-preview（互換 alias）
  claude-sonnet  claude-sonnet-4-6
  claude-opus    claude-opus-4-6
  copilot-mini   gpt-5-mini
  copilot-pro    gpt-5.2

Preset bundles:
  all/full/5mode/layered   探,極,均,監,刃 を単発でまとめて実行
  探,監,刃                 カンマ区切りで任意の多層指定

Examples:
  pcc-critic "この設計の弱点は？"
  pcc-critic --runtime copilot --model copilot-mini --preset 探 "分析しろ"
  pcc-critic --runtime claude --preset 刃 "この設計をレビューしろ"
  cat diff.txt | pcc-critic --preset 監 "この diff を監査しろ"
        """,
    )
    parser.add_argument("prompt", nargs="?", help="プロンプト（stdinからも読める）")
    parser.add_argument("--preset", "-P", default="探",
                        help="PCC プリセット。単体(探) / カンマ区切り(探,監,刃) / alias(all)")
    parser.add_argument("--model", "-m", default="deep",
                        help="モデル名 or ショートカット (fast/standard/plan/deep/claude-*/copilot-*)")
    parser.add_argument("--timeout", "-t", type=int, default=120, help="タイムアウト秒")
    parser.add_argument("--json", "-j", action="store_true", help="JSON 出力")
    parser.add_argument("--max-input-chars", type=int, default=100000,
                        help="パイプ入力の最大文字数（デフォルト: 100000）")
    parser.add_argument("--runtime", choices=["gemini", "claude", "copilot"], default="gemini",
                        help="実行ランタイム (gemini/claude/copilot、デフォルト: gemini)")
    parser.add_argument("--audit-only", action="store_true",
                        help="stdin のテキストを監査するだけ（LLM 呼び出しなし）")

    args = parser.parse_args()

    # stdin からの入力を取得（サイズ制限付き）
    stdin_text = ""
    if not sys.stdin.isatty():
        stdin_text = sys.stdin.read().strip()
        if len(stdin_text) > args.max_input_chars:
            print(f"[ACP×CLI×PCC] Warning: 入力が {len(stdin_text)} 文字あり、"
                  f"{args.max_input_chars} 文字に切り詰めます", file=sys.stderr)
            stdin_text = stdin_text[:args.max_input_chars]

    if args.audit_only:
        text = stdin_text or (args.prompt or "")
        audit = audit_response(text)
        if args.json:
            print(json.dumps(audit, ensure_ascii=False, indent=2))
        else:
            for k, v in audit.items():
                print(f"  {k}: {v}")
        sys.exit(0 if audit["verdict"] == "PASS" else 1)

    # プロンプト構築
    prompt = args.prompt or ""
    if stdin_text:
        prompt = f"{stdin_text}\n\n---\n{prompt}" if prompt else stdin_text

    if not prompt:
        parser.error("プロンプトを指定するか、stdin からパイプしてください")

    try:
        presets = normalize_preset_spec(args.preset)
    except ValueError as exc:
        parser.error(str(exc))

    # モデル解決（設定ファイル対応）
    routing = load_model_routing()
    model = routing.get(args.model, args.model)

    # PCC 注入
    enriched = inject_pcc(prompt, presets, args.runtime)
    preset_label = ",".join(presets)

    if not args.json:
        if len(presets) == 1:
            print(f"[ACP×CLI×PCC] Preset: #{preset_label} → {PCC_PRESETS[presets[0]]['label']}")
        else:
            print(f"[ACP×CLI×PCC] Preset bundle: {preset_label} (single-shot layered synthesis)")
        print(f"[Runtime] {args.runtime}")
        print(f"[Model] {model}")
        print(f"[Prompt] {len(enriched)} chars")
        print("─" * 50)

    # LLM 実行
    if args.runtime == "claude":
        result = run_claude(enriched, model, args.timeout)
    elif args.runtime == "copilot":
        result = run_copilot(enriched, model, args.timeout)
    else:
        result = run_gemini(enriched, model, args.timeout)

    # Audit
    audit = audit_response(result["text"])

    if args.json:
        output = {
            "runtime": args.runtime,
            "pcc_preset": preset_label,
            "pcc_presets": presets,
            "model": model,
            "response": result["text"],
            "elapsed": result["elapsed"],
            "exit_code": result["exit_code"],
            "audit": audit,
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        print(result["text"])
        print("─" * 50)
        print(f"[Audit] verdict={audit['verdict']} sycophancy={audit['sycophancy']} "
              f"evidence={audit['evidence_count']} words={audit['words']} "
              f"time={result['elapsed']}s")

    # exit code: 0=PASS, 1=other
    sys.exit(0 if audit["verdict"] == "PASS" else 1)


if __name__ == "__main__":
    main()
