/**
 * Port of `lib/features/debug/logs_screen.dart`.
 *
 * Tails the ring buffer in `core/log.rs`, which both Rust and the frontend
 * write into, so the two sides interleave in one stream.
 */

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import * as api from "@/api/client";
import { useLogs } from "@/api/queries";
import { Icon } from "@/components/Icon";
import { AsyncView, hoverPill } from "@/components/common";
import type { LogEntry } from "@/models";

const LEVELS = ["ALL", "ERROR", "WARN", "INFO", "DEBUG", "TRACE"] as const;

export function Logs() {
  const navigate = useNavigate();
  const logs = useLogs();
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("ALL");
  const [filter, setFilter] = useState("");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg)" }}>
      <header
        data-tauri-drag-region
        style={{
          height: "var(--top-bar-height)",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 12px",
          borderBottom: "var(--border-width) solid var(--border-dim)",
        }}
      >
        <button onClick={() => navigate(-1)} title="back" style={{ display: "flex", padding: 4 }}>
          <Icon name="arrowBack" size={17} color="var(--text-mid)" />
        </button>
        <span className="t-heading">logs</span>

        <div style={{ display: "flex", gap: 2, marginLeft: 8 }}>
          {LEVELS.map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className="t-code"
              style={{
                padding: "3px 7px",
                borderRadius: "var(--radius-sm)",
                background: level === l ? "var(--surface3)" : "transparent",
                color: level === l ? "var(--text-hi)" : "var(--text-low)",
              }}
            >
              {l}
            </button>
          ))}
        </div>

        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter…"
          style={{
            marginLeft: "auto",
            width: 200,
            height: 26,
            padding: "0 9px",
            borderRadius: "var(--radius-sm)",
            background: "var(--surface)",
            border: "var(--border-width) solid var(--border-dim)",
            fontSize: 12,
            userSelect: "text",
          }}
        />
        <button
          onClick={async () => {
            await api.logsClear();
            void logs.refetch();
          }}
          style={hoverPill}
        >
          <Icon name="trash" size={13} />
          clear
        </button>
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
        <AsyncView query={logs}>
          {(entries) => <LogList entries={entries} level={level} filter={filter} />}
        </AsyncView>
      </div>
    </div>
  );
}

function LogList({
  entries,
  level,
  filter,
}: {
  entries: LogEntry[];
  level: string;
  filter: string;
}) {
  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return entries.filter((e) => {
      if (level !== "ALL" && e.level.toUpperCase() !== level) return false;
      if (!needle) return true;
      return (
        e.message.toLowerCase().includes(needle) || e.target.toLowerCase().includes(needle)
      );
    });
  }, [entries, level, filter]);

  if (rows.length === 0) {
    return (
      <div className="t-label" style={{ padding: 16, color: "var(--text-low)" }}>
        nothing matches
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {rows.map((e, i) => (
        <div
          key={`${e.at}-${i}`}
          className="t-code"
          style={{
            display: "flex",
            gap: 10,
            padding: "3px 6px",
            borderRadius: "var(--radius-sm)",
            background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)",
            userSelect: "text",
          }}
        >
          <span style={{ color: "var(--text-low)", flexShrink: 0 }}>
            {new Date(e.at).toLocaleTimeString(undefined, { hour12: false })}
          </span>
          <span style={{ width: 46, flexShrink: 0, color: levelColor(e.level) }}>
            {e.level}
          </span>
          <span style={{ width: 130, flexShrink: 0, color: "var(--text-low)" }} className="truncate">
            {e.target}
          </span>
          <span style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {e.message}
          </span>
        </div>
      ))}
    </div>
  );
}

function levelColor(level: string): string {
  switch (level.toUpperCase()) {
    case "ERROR":
      return "#ff6b5e";
    case "WARN":
      return "var(--acid)";
    case "INFO":
      return "var(--text-mid)";
    default:
      return "var(--text-low)";
  }
}
