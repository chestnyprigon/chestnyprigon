import { Info } from "lucide-react";

export function InfoTooltip({ label, children }: { label: string; children: string }) {
  return (
    <details className="info-tooltip">
      <summary aria-label={label}>
        <Info size={15} strokeWidth={2} aria-hidden="true" />
      </summary>
      <span role="tooltip">{children}</span>
    </details>
  );
}
