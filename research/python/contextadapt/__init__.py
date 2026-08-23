"""ContextAdapt: provenance-aware context diagnostics for agent trajectories."""

from .diagnose import build_snapshot, diagnose_trace
from .demo import demo_events, demo_snapshot
from .schema import TraceEvent, dump_jsonl, load_jsonl
from .relations import evaluate_action_with_relation, validate_relation_bundle

__all__ = [
    "TraceEvent",
    "build_snapshot",
    "demo_events",
    "demo_snapshot",
    "diagnose_trace",
    "dump_jsonl",
    "load_jsonl",
    "evaluate_action_with_relation",
    "validate_relation_bundle",
]
__version__ = "0.1.0"
