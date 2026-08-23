"""Command-line interface for ContextAdapt."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .adapters.codex_exec import convert_codex_exec
from .demo import demo_events, demo_snapshot, render_demo
from .diagnose import diagnose_trace, render_text
from .executor_guard import (
    codex_hook_output,
    compile_executor_guard,
    evaluate_executor_call,
    load_executor_guard,
)
from .presentation import gate_status, render_check
from .relations import evaluate_action_with_relation, render_relation_verdict, validate_relation_bundle
from .schema import dump_jsonl, load_jsonl
from .semantic_codex import DEFAULT_MODEL, run_two_pass_codex_analysis


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        prog="contextadapt",
        description="Catch AI Agent actions built from stale or mis-bound context.",
        epilog="New here? From the source checkout run `python3 -m contextadapt demo`.",
    )
    subcommands = root.add_subparsers(dest="command", required=True)
    diagnose = subcommands.add_parser("diagnose", help="Build a provenance-aware ContextSnapshot from JSONL events.")
    diagnose.add_argument("trace", type=Path, help="Path to a contextadapt.trace.v1 JSONL file.")
    diagnose.add_argument("--trace-id", help="Stable trace identifier; defaults to the input filename stem.")
    diagnose.add_argument("--format", choices=("text", "json"), default="text")
    diagnose.add_argument("--output", type=Path, help="Write output to a file instead of stdout.")
    diagnose.add_argument("--fail-on-risk", action="store_true", help="Exit with status 2 when any high/critical risk is detected.")
    check = subcommands.add_parser(
        "check",
        help=(
            "Gate candidate actions: print PASS, BLOCK, or INSUFFICIENT_EVIDENCE; "
            "exit 2 unless the result is PASS."
        ),
    )
    check.add_argument("trace", type=Path, help="Path to a contextadapt.trace.v1 JSONL file.")
    check.add_argument("--trace-id", help="Stable trace identifier; defaults to the input filename stem.")
    check.add_argument("--format", choices=("text", "json"), default="text")
    check.add_argument("--output", type=Path, help="Write output to a file instead of stdout.")
    demo = subcommands.add_parser("demo", help="Run a zero-configuration stale-action safety demo.")
    demo.add_argument("--format", choices=("text", "json"), default="text")
    demo.add_argument("--trace-out", type=Path, help="Also write the seven underlying trace events as JSONL.")
    import_codex = subcommands.add_parser(
        "import-codex",
        help="Convert stdout from `codex exec --json` into a privacy-safe ContextAdapt trace.",
    )
    import_codex.add_argument("source", help="Codex JSONL path, or - to read stdin.")
    import_codex.add_argument("--output", type=Path, required=True, help="Destination contextadapt.trace.v1 JSONL path.")
    import_codex.add_argument(
        "--instruction-file",
        type=Path,
        help="Optional original prompt file; fingerprinted by default because the Codex stream omits it.",
    )
    import_codex.add_argument(
        "--include-content",
        action="store_true",
        help="Include raw prompts, commands, outputs, and messages. Off by default; review before sharing.",
    )
    reconcile = subcommands.add_parser(
        "reconcile",
        help="Verify an AI-proposed context relation with engineering checks and an independent review.",
    )
    reconcile.add_argument("trace", type=Path, help="JSONL containing the older/newer events and candidate action.")
    reconcile.add_argument("proposal", type=Path, help="AI field-level relation proposal JSON.")
    reconcile.add_argument("review", type=Path, help="Independent AI review JSON bound to the proposal digest.")
    reconcile.add_argument("--action-event", help="Candidate action event to check against the accepted relation.")
    reconcile.add_argument("--format", choices=("text", "json"), default="text")
    analyze_codex = subcommands.add_parser(
        "analyze-codex",
        help="Explicitly run two separate Codex semantic analyses, then apply the deterministic relation gate.",
    )
    analyze_codex.add_argument("trace", type=Path)
    analyze_codex.add_argument("older_event_id")
    analyze_codex.add_argument("newer_event_id")
    analyze_codex.add_argument("--action-event")
    analyze_codex.add_argument("--model", default=DEFAULT_MODEL)
    analyze_codex.add_argument("--output-dir", type=Path, help="Save the host-attested proposal and review JSON.")
    analyze_codex.add_argument(
        "--allow-remote-content",
        action="store_true",
        help="Required acknowledgement that the selected raw event text/facts will be sent to Codex.",
    )
    analyze_codex.add_argument("--format", choices=("text", "json"), default="text")
    compile_guard = subcommands.add_parser(
        "compile-guard",
        help="Compile an accepted context relation into a deterministic pre-tool executor guard.",
    )
    compile_guard.add_argument("trace", type=Path)
    compile_guard.add_argument("proposal", type=Path)
    compile_guard.add_argument("review", type=Path)
    compile_guard.add_argument("--output", type=Path, required=True)
    executor_hook = subcommands.add_parser(
        "executor-hook",
        help="Evaluate one native Codex or OMP pre-tool hook payload from stdin.",
    )
    executor_hook.add_argument("host", choices=("codex", "omp"))
    executor_hook.add_argument("--policy", type=Path, required=True)
    executor_hook.add_argument("--format", choices=("native", "json"), default="native")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.command == "demo":
        snapshot = demo_snapshot()
        if args.trace_out:
            args.trace_out.parent.mkdir(parents=True, exist_ok=True)
            args.trace_out.write_text(dump_jsonl(demo_events()), encoding="utf-8")
        if args.format == "json":
            sys.stdout.write(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n")
        else:
            sys.stdout.write(render_demo(snapshot))
        return 0

    if args.command == "import-codex":
        try:
            if args.source == "-":
                source_lines = sys.stdin
            else:
                source_path = Path(args.source)
                if source_path.resolve() == args.output.resolve():
                    raise ValueError("source and output must be different files")
                source_lines = source_path.read_text(encoding="utf-8").splitlines()
            instruction = args.instruction_file.read_text(encoding="utf-8") if args.instruction_file else None
            rendered = dump_jsonl(
                convert_codex_exec(
                    source_lines,
                    include_content=args.include_content,
                    instruction=instruction,
                )
            )
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(rendered, encoding="utf-8")
        except (OSError, ValueError) as exc:
            print(f"contextadapt: {exc}", file=sys.stderr)
            return 1
        return 0

    if args.command == "reconcile":
        try:
            events = load_jsonl(args.trace)
            proposal = json.loads(args.proposal.read_text(encoding="utf-8"))
            review = json.loads(args.review.read_text(encoding="utf-8"))
            if not isinstance(proposal, dict) or not isinstance(review, dict):
                raise ValueError("proposal and review must each be a JSON object")
            verdict = validate_relation_bundle(events, proposal, review)
            action = (
                evaluate_action_with_relation(events, verdict, args.action_event)
                if args.action_event
                else None
            )
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f"contextadapt: {exc}", file=sys.stderr)
            return 1
        if args.format == "json":
            sys.stdout.write(json.dumps({"relation": verdict, "action": action}, ensure_ascii=False, indent=2) + "\n")
        else:
            sys.stdout.write(render_relation_verdict(verdict, action))
        if verdict["status"] == "REJECTED":
            return 1
        if verdict["status"] != "ACCEPTED" or (action and action["status"] != "PASS"):
            return 2
        return 0

    if args.command == "analyze-codex":
        if not args.allow_remote_content:
            print(
                "contextadapt: refusing remote semantic calls without --allow-remote-content",
                file=sys.stderr,
            )
            return 1
        try:
            events = load_jsonl(args.trace)
            proposal, review = run_two_pass_codex_analysis(
                events,
                args.older_event_id,
                args.newer_event_id,
                model=args.model,
            )
            verdict = validate_relation_bundle(events, proposal, review)
            action = (
                evaluate_action_with_relation(events, verdict, args.action_event)
                if args.action_event
                else None
            )
            if args.output_dir:
                args.output_dir.mkdir(parents=True, exist_ok=True)
                (args.output_dir / "relation-proposal.json").write_text(
                    json.dumps(proposal, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                (args.output_dir / "relation-review.json").write_text(
                    json.dumps(review, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
        except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
            print(f"contextadapt: {exc}", file=sys.stderr)
            return 1
        payload = {"relation": verdict, "action": action, "proposal": proposal, "review": review}
        if args.format == "json":
            sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        else:
            sys.stdout.write(render_relation_verdict(verdict, action))
        if verdict["status"] != "ACCEPTED" or (action and action["status"] != "PASS"):
            return 2
        return 0

    if args.command == "compile-guard":
        try:
            events = load_jsonl(args.trace)
            proposal = json.loads(args.proposal.read_text(encoding="utf-8"))
            review = json.loads(args.review.read_text(encoding="utf-8"))
            if not isinstance(proposal, dict) or not isinstance(review, dict):
                raise ValueError("proposal and review must each be a JSON object")
            guard = compile_executor_guard(events, proposal, review)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(guard, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f"contextadapt: {exc}", file=sys.stderr)
            return 1
        return 0

    if args.command == "executor-hook":
        try:
            payload = json.loads(sys.stdin.read())
            if not isinstance(payload, dict):
                raise ValueError("hook stdin must be one JSON object")
            decision = evaluate_executor_call(args.host, payload, load_executor_guard(args.policy))
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            decision = {
                "schema_version": "contextadapt.executor-decision.v1",
                "decision": "BLOCK",
                "guard_id": None,
                "reasons": [f"ContextAdapt could not assess the tool call: {exc}"],
            }
        if args.format == "json" or args.host == "omp":
            sys.stdout.write(json.dumps(decision, ensure_ascii=False) + "\n")
        else:
            native = codex_hook_output(decision)
            if native is not None:
                sys.stdout.write(json.dumps(native, ensure_ascii=False) + "\n")
        return 0

    try:
        events = load_jsonl(args.trace)
        snapshot = diagnose_trace(events, args.trace_id or args.trace.stem)
    except (OSError, ValueError) as exc:
        print(f"contextadapt: {exc}", file=sys.stderr)
        return 1
    if args.format == "json":
        if args.command == "check":
            snapshot["gate_verdict"] = gate_status(snapshot)
        rendered = json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n"
    elif args.command == "check":
        rendered = render_check(snapshot)
    else:
        rendered = render_text(snapshot)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    if args.command == "check" and gate_status(snapshot) != "PASS":
        return 2
    if args.command == "diagnose" and args.fail_on_risk and snapshot["risk_summary"]["total"]:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
