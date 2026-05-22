import { useEffect, useRef, useState } from "react";
import type { LinearWorkflowState } from "./linear";
import { StatusCircle } from "./StatusCircle";
import { getStateProgress } from "./workflowState";
import { headerInputStyle } from "./appStyles";

export function StatusSelect({ states, startedStates, value, onChange }: {
  states: LinearWorkflowState[];
  startedStates: LinearWorkflowState[];
  value: string;
  onChange: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = states.find((s) => s.name === value);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ ...headerInputStyle, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", background: "var(--bg)", minWidth: 120 }}
      >
        {selected && <StatusCircle stateType={selected.type} color={selected.color} progress={getStateProgress(selected, startedStates)} size={12} />}
        <span style={{ flex: 1, textAlign: "left" }}>{selected?.name ?? value}</span>
        <span style={{ fontSize: 10, opacity: 0.5 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, marginTop: 2, zIndex: 100,
          background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6,
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)", minWidth: "100%", maxHeight: 260, overflowY: "auto",
        }}>
          {states.map((s) => (
            <button
              key={s.id}
              onClick={() => { onChange(s.name); setOpen(false); }}
              style={{
                display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "6px 10px",
                border: "none", background: s.name === value ? "var(--surface-hover)" : "transparent",
                color: "var(--text)", fontSize: 13, cursor: "pointer", textAlign: "left",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--surface-hover)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = s.name === value ? "var(--surface-hover)" : "transparent"; }}
            >
              <StatusCircle stateType={s.type} color={s.color} progress={getStateProgress(s, startedStates)} size={12} />
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
