/** Relative brand-mix weights from the approved baseline; values are not publication counts or caps. */
export const APPROVED_BRAND_MIX_WEIGHTS = [
  ["Hyundai",185],["Kia",167],["Mercedes-Benz",150],["BMW",140],["Genesis",84],
  ["Audi",57],["Volkswagen",33],["Land Rover",31],["Porsche",27],["Volvo",25],
  ["MINI",23],["Toyota",16],["Lexus",14],["Chevrolet",11],["KGM",11],
  ["Renault Korea",10],["Honda",9],["Jaguar",5],["Nissan",1],["Mazda",1],
].map(([manufacturer,weight]) => ({ manufacturer: String(manufacturer), target: Number(weight) }));
