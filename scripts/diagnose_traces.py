#!/usr/bin/env python3
"""
Bottleneck Diagnostic Tool for Claude Code Patched CLI Traces

Analyzes JSONL traces from phase-trace and telemetry-transparency patches
to identify performance bottlenecks in agent responses.

Usage:
    python scripts/diagnose_traces.py traces.jsonl
    python scripts/diagnose_traces.py traces.jsonl --threshold 50
    python scripts/diagnose_traces.py traces.jsonl --format json
    cat traces.jsonl | python scripts/diagnose_traces.py -

Trace capture:
    CCDECOMP_PHASE_TRACE=1 CCDECOMP_PHASE_TRACE_FORMAT=jsonl \
    CCDECOMP_TELEMETRY_TRACE=1 CCDECOMP_TELEMETRY_DRY_RUN=1 \
    uv run uvicorn main:app 2>traces.jsonl
"""

import argparse
import json
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from statistics import mean, median, stdev


@dataclass
class PhaseEvent:
    marker: str
    dt_ms: float  # Delta from previous phase
    t_ms: float  # Total time from start
    count: int


@dataclass
class TelemetryEvent:
    event: str
    keys: list[str]
    level: str = "info"


@dataclass
class SessionStats:
    phases: list[PhaseEvent] = field(default_factory=list)
    telemetry: list[TelemetryEvent] = field(default_factory=list)
    total_time_ms: float = 0


@dataclass
class AggregateStats:
    phase_times: dict[str, list[float]] = field(default_factory=lambda: defaultdict(list))
    phase_counts: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    telemetry_counts: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    session_count: int = 0


def parse_traces(input_stream) -> tuple[list[SessionStats], AggregateStats]:
    """Parse JSONL traces into structured data."""
    sessions: list[SessionStats] = []
    aggregate = AggregateStats()
    current_session = SessionStats()

    for line in input_stream:
        line = line.strip()
        if not line:
            continue

        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue

        event_type = data.get("type")

        if event_type == "phase":
            marker = data.get("marker", "unknown")
            dt_ms = data.get("dt_ms", 0)
            t_ms = data.get("t_ms", 0)
            count = data.get("count", 1)

            phase = PhaseEvent(marker=marker, dt_ms=dt_ms, t_ms=t_ms, count=count)
            current_session.phases.append(phase)
            current_session.total_time_ms = t_ms

            aggregate.phase_times[marker].append(dt_ms)
            aggregate.phase_counts[marker] += 1

            # Detect session boundary (cli_entry marks new session)
            if marker == "cli_entry" and len(current_session.phases) > 1:
                sessions.append(current_session)
                aggregate.session_count += 1
                current_session = SessionStats()
                current_session.phases.append(phase)

        elif event_type == "telemetry":
            event_name = data.get("event", "unknown")
            keys = data.get("keys", [])
            level = data.get("level", "info")

            telemetry = TelemetryEvent(event=event_name, keys=keys, level=level)
            current_session.telemetry.append(telemetry)
            aggregate.telemetry_counts[event_name] += 1

    # Don't forget the last session
    if current_session.phases:
        sessions.append(current_session)
        aggregate.session_count += 1

    return sessions, aggregate


def find_bottlenecks(aggregate: AggregateStats, threshold_ms: float = 100) -> list[dict]:
    """Identify phases that exceed the threshold."""
    bottlenecks = []

    for marker, times in aggregate.phase_times.items():
        if not times:
            continue

        avg_time = mean(times)
        max_time = max(times)

        if avg_time >= threshold_ms or max_time >= threshold_ms * 2:
            bottleneck = {
                "marker": marker,
                "avg_ms": round(avg_time, 2),
                "max_ms": round(max_time, 2),
                "min_ms": round(min(times), 2),
                "median_ms": round(median(times), 2),
                "count": len(times),
                "severity": "high" if avg_time >= threshold_ms * 2 else "medium",
            }
            if len(times) > 1:
                bottleneck["stdev_ms"] = round(stdev(times), 2)
            bottlenecks.append(bottleneck)

    return sorted(bottlenecks, key=lambda x: x["avg_ms"], reverse=True)


def get_phase_flow(sessions: list[SessionStats]) -> list[dict]:
    """Get the typical phase flow with timing."""
    if not sessions:
        return []

    # Use the first complete session as template
    longest_session = max(sessions, key=lambda s: len(s.phases))

    flow = []
    for phase in longest_session.phases:
        flow.append({"marker": phase.marker, "dt_ms": phase.dt_ms, "cumulative_ms": phase.t_ms})

    return flow


def get_telemetry_summary(aggregate: AggregateStats) -> list[dict]:
    """Summarize telemetry events by frequency."""
    summary = []
    for event, count in sorted(aggregate.telemetry_counts.items(), key=lambda x: -x[1]):
        summary.append({"event": event, "count": count})
    return summary[:20]  # Top 20


def format_text_report(
    sessions: list[SessionStats], aggregate: AggregateStats, bottlenecks: list[dict], threshold_ms: float
) -> str:
    """Generate human-readable text report."""
    lines = []
    lines.append("=" * 60)
    lines.append("CLAUDE CODE TRACE DIAGNOSTIC REPORT")
    lines.append("=" * 60)
    lines.append("")

    # Summary
    lines.append(f"Sessions analyzed: {aggregate.session_count}")
    lines.append(f"Total phase events: {sum(aggregate.phase_counts.values())}")
    lines.append(f"Total telemetry events: {sum(aggregate.telemetry_counts.values())}")
    lines.append(f"Bottleneck threshold: {threshold_ms}ms")
    lines.append("")

    # Bottlenecks
    lines.append("-" * 60)
    lines.append("BOTTLENECKS (phases exceeding threshold)")
    lines.append("-" * 60)

    if bottlenecks:
        for b in bottlenecks:
            severity_icon = "!!" if b["severity"] == "high" else "!"
            lines.append(f"  {severity_icon} {b['marker']}")
            lines.append(f"     avg: {b['avg_ms']}ms  max: {b['max_ms']}ms  count: {b['count']}")
    else:
        lines.append("  No bottlenecks detected above threshold")
    lines.append("")

    # Phase flow
    lines.append("-" * 60)
    lines.append("PHASE FLOW (typical session)")
    lines.append("-" * 60)

    flow = get_phase_flow(sessions)
    for i, phase in enumerate(flow):
        bar_len = min(int(phase["dt_ms"] / 10), 40)
        bar = "#" * bar_len if bar_len > 0 else "."
        lines.append(f"  {i+1:2}. {phase['marker']:<35} +{phase['dt_ms']:>6.1f}ms  {bar}")
    lines.append("")

    # Top telemetry
    telemetry_summary = get_telemetry_summary(aggregate)
    if telemetry_summary:
        lines.append("-" * 60)
        lines.append("TOP TELEMETRY EVENTS")
        lines.append("-" * 60)
        for t in telemetry_summary[:10]:
            lines.append(f"  {t['event']:<45} {t['count']:>5}x")
        lines.append("")

    # Phase statistics
    lines.append("-" * 60)
    lines.append("ALL PHASE STATISTICS")
    lines.append("-" * 60)

    phase_stats = []
    for marker, times in aggregate.phase_times.items():
        if times:
            phase_stats.append({"marker": marker, "avg": mean(times), "count": len(times)})

    for p in sorted(phase_stats, key=lambda x: -x["avg"]):
        lines.append(f"  {p['marker']:<40} avg: {p['avg']:>7.1f}ms  ({p['count']}x)")

    lines.append("")
    lines.append("=" * 60)

    return "\n".join(lines)


def format_json_report(
    sessions: list[SessionStats], aggregate: AggregateStats, bottlenecks: list[dict], threshold_ms: float
) -> str:
    """Generate JSON report."""
    report = {
        "summary": {
            "sessions_analyzed": aggregate.session_count,
            "total_phase_events": sum(aggregate.phase_counts.values()),
            "total_telemetry_events": sum(aggregate.telemetry_counts.values()),
            "bottleneck_threshold_ms": threshold_ms,
        },
        "bottlenecks": bottlenecks,
        "phase_flow": get_phase_flow(sessions),
        "telemetry_summary": get_telemetry_summary(aggregate),
        "phase_statistics": {
            marker: {
                "avg_ms": round(mean(times), 2),
                "max_ms": round(max(times), 2),
                "min_ms": round(min(times), 2),
                "count": len(times),
            }
            for marker, times in aggregate.phase_times.items()
            if times
        },
    }
    return json.dumps(report, indent=2)


def main():
    parser = argparse.ArgumentParser(
        description="Analyze Claude Code patched CLI traces for bottlenecks",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("input", help="JSONL trace file path, or '-' for stdin")
    parser.add_argument(
        "--threshold", "-t", type=float, default=100, help="Bottleneck threshold in milliseconds (default: 100)"
    )
    parser.add_argument(
        "--format", "-f", choices=["text", "json"], default="text", help="Output format (default: text)"
    )

    args = parser.parse_args()

    # Open input
    if args.input == "-":
        input_stream = sys.stdin
    else:
        path = Path(args.input)
        if not path.exists():
            print(f"Error: File not found: {args.input}", file=sys.stderr)
            sys.exit(1)
        input_stream = open(path)

    try:
        sessions, aggregate = parse_traces(input_stream)
    finally:
        if args.input != "-":
            input_stream.close()

    if aggregate.session_count == 0:
        print("No trace data found. Ensure traces are in JSONL format.", file=sys.stderr)
        sys.exit(1)

    bottlenecks = find_bottlenecks(aggregate, args.threshold)

    if args.format == "json":
        print(format_json_report(sessions, aggregate, bottlenecks, args.threshold))
    else:
        print(format_text_report(sessions, aggregate, bottlenecks, args.threshold))


if __name__ == "__main__":
    main()
