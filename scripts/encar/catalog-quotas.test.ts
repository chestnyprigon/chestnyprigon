import assert from "node:assert/strict";
import test from "node:test";
import { APPROVED_BRAND_QUOTAS, calculateBrandQuotas } from "../catalog/brand-quotas";
test("approved brand targets total 1000 and reproduce the frozen baseline calculation",()=>{
  const counts={Hyundai:5310,Kia:4791,"Mercedes-Benz":4324,BMW:4013,Genesis:2414,Audi:1625,Volkswagen:921,"Land Rover":874,Porsche:740,Volvo:679,MINI:641,Toyota:428,Lexus:365,Chevrolet:295,KGM:285,"Renault Korea":271,Honda:237,Jaguar:126,Nissan:10,Mazda:3};
  assert.equal(APPROVED_BRAND_QUOTAS.reduce((s,q)=>s+q.target,0),1000);
  assert.deepEqual(new Map(calculateBrandQuotas(counts).map(q=>[q.manufacturer,q.target])),new Map(APPROVED_BRAND_QUOTAS.map(q=>[q.manufacturer,q.target])));
});
test("small brands retain one place and rounding never changes the target",()=>{
  const q=calculateBrandQuotas({A:999999,B:1,C:1},1000);
  assert.equal(q.reduce((s,b)=>s+b.target,0),1000);assert.ok(q.every(b=>b.target>=1));
  assert.throws(()=>calculateBrandQuotas({A:1,B:1},1));
});
