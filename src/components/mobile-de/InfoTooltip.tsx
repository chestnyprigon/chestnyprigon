export function InfoTooltip({ label, children }: { label: string; children: string }) {
  return (
    <details className="info-tooltip">
      <summary aria-label={label}>i</summary>
      <span role="tooltip">{children}</span>
    </details>
  );
}
