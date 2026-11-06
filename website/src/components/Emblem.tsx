import React from 'react';
import { emblemPath } from '../data/workspaces';

interface EmblemProps {
  id: string;
  size?: number;
  className?: string;
  color?: string;
}

export function Emblem({ id, size = 48, className = '', color = 'currentColor' }: EmblemProps) {
  const d = emblemPath(id);

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={`nx-emblem-svg ${className}`}
      fill="none"
      stroke={color}
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} fill="currentColor" fillOpacity="0.08" />
    </svg>
  );
}

