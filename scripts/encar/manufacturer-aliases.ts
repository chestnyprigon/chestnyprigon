/** Encar manufacturer labels observed in search payloads. */
export const MANUFACTURER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  Hyundai: ["현대"],
  Kia: ["기아"],
  Genesis: ["제네시스"],
  "Mercedes-Benz": ["벤츠"],
  Audi: ["아우디"],
  Volkswagen: ["폭스바겐"],
  Porsche: ["포르쉐"],
  Volvo: ["볼보"],
  "Land Rover": ["랜드로버"],
  Lexus: ["렉서스"],
  Jaguar: ["재규어"],
  MINI: ["미니"],
  Toyota: ["도요타", "토요타"],
  Nissan: ["닛산"],
  Mazda: ["마쯔다", "마쓰다", "마츠다"],
  Honda: ["혼다"],
  Subaru: ["스바루"],
  Chevrolet: ["쉐보레", "GM대우"],
  Mitsubishi: ["미쓰비시", "미츠비시"],
  Ford: ["포드"],
  Jeep: ["지프"],
  "Renault Korea": ["르노", "르노코리아", "르노삼성"],
  KGM: ["쌍용", "KG모빌리티", "KG모빌리티(쌍용)"],
  BMW: ["BMW"],
  Peugeot: ["푸조"],
};

export function manufacturerAliases(manufacturer: string) {
  return MANUFACTURER_ALIASES[manufacturer] ?? [manufacturer];
}

export function primaryManufacturerAlias(manufacturer: string) {
  return manufacturerAliases(manufacturer)[0];
}
