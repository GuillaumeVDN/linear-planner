/** Pie arc path from 12 o'clock sweeping clockwise by `progress` (0-1) */
function pieArc(cx: number, cy: number, r: number, progress: number): string {
  if (progress <= 0) return "";
  if (progress >= 1) return `M${cx},${cy}m${-r},0a${r},${r},0,1,0,${r * 2},0a${r},${r},0,1,0,${-r * 2},0`;
  const angle = -Math.PI / 2 + progress * 2 * Math.PI;
  const ex = cx + r * Math.cos(angle);
  const ey = cy + r * Math.sin(angle);
  const large = progress > 0.5 ? 1 : 0;
  return `M${cx} ${cy} L${cx} ${cy - r} A${r} ${r} 0 ${large} 1 ${ex} ${ey} Z`;
}

export function StatusCircle({ stateType, color, progress = 0, size = 14 }: { stateType: string; color: string; progress?: number; size?: number }) {
  const r = size / 2;
  const cx = r;
  const cy = r;
  const sr = r - 1.5;

  if (stateType === "completed") {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
        <circle cx={cx} cy={cy} r={sr} fill={color} />
        <path d={`M${r * 0.55} ${r} L${r * 0.85} ${r * 1.25} L${r * 1.45} ${r * 0.7}`} fill="none" stroke="#fff" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (stateType === "canceled") {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
        <circle cx={cx} cy={cy} r={sr} fill="none" stroke={color} strokeWidth={1.5} />
        <path d={`M${r * 0.7} ${r * 0.7} L${r * 1.3} ${r * 1.3} M${r * 1.3} ${r * 0.7} L${r * 0.7} ${r * 1.3}`} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      </svg>
    );
  }
  if (stateType === "started" && progress > 0) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
        <circle cx={cx} cy={cy} r={sr} fill="none" stroke={color} strokeWidth={1.5} />
        <path d={pieArc(cx, cy, sr, progress)} fill={color} />
      </svg>
    );
  }
  const dashArray = stateType === "backlog" ? `${sr * 0.8} ${sr * 0.8}` : undefined;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={cx} cy={cy} r={sr} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray={dashArray} />
    </svg>
  );
}
