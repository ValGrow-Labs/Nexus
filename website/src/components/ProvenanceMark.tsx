import type { CSSProperties } from 'react';

interface ProvenanceMarkProps {
  hueSlot?: number | null;
  size?: number;
  className?: string;
  label?: string;
}

export function provenanceStyle(slot: number | null | undefined): CSSProperties {
  if (slot == null || slot < 0) return {};
  const hue = Math.round(((265 + slot * 137.508) % 360) * 10) / 10;
  return { '--ws-h': hue } as CSSProperties;
}

export function ProvenanceMark({ hueSlot, size = 10, className = '', label }: ProvenanceMarkProps) {
  const isNone = hueSlot == null || hueSlot < 0;
  const style = provenanceStyle(hueSlot);

  return (
    <span
      className={`nx-prov-mark ${isNone ? 'nx-prov--none' : 'nx-prov'} ${className}`}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: 'currentColor',
        flexShrink: 0,
        ...style
      }}
      title={label ? `${label} provenance mark` : undefined}
      aria-hidden="true"
    />
  );
}

