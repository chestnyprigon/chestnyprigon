export type ReportUsageFlags = {
  rental: boolean;
  taxi: boolean;
  commercial: boolean;
};

export function reportScreening(flags: ReportUsageFlags, hasAccident: boolean) {
  const hardExclusion = flags.rental || flags.taxi || flags.commercial;
  const reasonCodes = [
    ...(flags.rental ? ["inspection_rental_history"] : []),
    ...(flags.taxi ? ["inspection_taxi_history"] : []),
    ...(flags.commercial ? ["inspection_commercial_history"] : []),
    ...(hasAccident ? ["encar_accident_history"] : []),
  ];

  return {
    decision: hardExclusion ? ("rejected" as const) : ("approved" as const),
    hardExclusion,
    // An accident is disclosed in the public report. It is not a publication blocker.
    isProblematic: false,
    reasonCodes,
  };
}
