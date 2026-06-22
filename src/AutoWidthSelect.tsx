import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

interface Option {
  value: string;
  label: string;
}

/**
 * A native <select> that sizes its closed width to the currently selected option
 * (plus room for the dropdown arrow) instead of the widest option. Cross-browser:
 * uses a hidden measuring span rather than CSS `field-sizing` (unsupported in Firefox).
 */
export function AutoWidthSelect({
  value,
  options,
  placeholder,
  onChange,
  style,
  maxWidth,
}: {
  value: string;
  options: Option[];
  placeholder?: string;
  onChange: (value: string) => void;
  style?: CSSProperties;
  maxWidth?: number;
}) {
  const measureRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);

  const selected = options.find((o) => o.value === value);
  const displayText = selected?.label ?? placeholder ?? "";

  useLayoutEffect(() => {
    if (measureRef.current) setWidth(measureRef.current.offsetWidth);
  }, [displayText, options.length]);

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...style, width, maxWidth, boxSizing: "border-box" }}
      >
        {!value && placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {/* Off-screen copy of the selected label, used to measure the natural width.
          Mirrors the select's box (font/padding/border) plus arrow room on the right. */}
      <span
        ref={measureRef}
        aria-hidden
        style={{
          ...style,
          position: "absolute",
          top: 0,
          left: 0,
          visibility: "hidden",
          whiteSpace: "nowrap",
          pointerEvents: "none",
          boxSizing: "border-box",
          paddingRight: 34,
        }}
      >
        {displayText}
      </span>
    </span>
  );
}
