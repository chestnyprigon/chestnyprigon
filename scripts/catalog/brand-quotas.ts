/** Owner-approved quotas from the 2026-10-06 baseline; each present brand has a floor of one. */
export const APPROVED_BRAND_QUOTAS = [
  ["Hyundai",185],["Kia",167],["Mercedes-Benz",150],["BMW",140],["Genesis",84],
  ["Audi",57],["Volkswagen",33],["Land Rover",31],["Porsche",27],["Volvo",25],
  ["MINI",23],["Toyota",16],["Lexus",14],["Chevrolet",11],["KGM",11],
  ["Renault Korea",10],["Honda",9],["Jaguar",5],["Nissan",1],["Mazda",1],
].map(([manufacturer,target]) => ({ manufacturer: String(manufacturer), target: Number(target) }));

export function calculateBrandQuotas(counts: Record<string, number>, target=1000) {
  const entries=Object.entries(counts).filter(([,count])=>count>0);
  if (!Number.isInteger(target) || target<entries.length || entries.length===0) throw Error("Invalid quota target or baseline");
  const total=entries.reduce((s,[,count])=>s+count,0), remaining=target-entries.length;
  const quotas=entries.map(([manufacturer,count])=>({ manufacturer,target:1+Math.floor(remaining*count/total),remainder:remaining*count/total%1 }));
  let residual=target-quotas.reduce((s,q)=>s+q.target,0);
  for (const q of [...quotas].sort((a,b)=>b.remainder-a.remainder||a.manufacturer.localeCompare(b.manufacturer))) { if (residual--<=0) break; q.target++; }
  return quotas.map(({manufacturer,target})=>({manufacturer,target}));
}
