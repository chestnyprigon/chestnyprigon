import test from "node:test";
import assert from "node:assert/strict";
import { parseMobileDeFilters, mobileDeFilterParams } from "./filters";

test("preserves exact dictionaries, zero and separate years",()=>{
 const result=parseMobileDeFilters({make:"Mercedes-Benz",model:"A 200",price_min:"0",year_min:"2020",registration_year_min:"2021",price_max:"30000,50"});
 assert.equal(result.valid,true);
 assert.equal(result.filters.price_min,"0");
 assert.equal(result.filters.price_max,"30000.5");
 assert.equal(result.filters.year_min,"2020");
 assert.equal(result.filters.registration_year_min,"2021");
 assert.equal(result.filters.model,"A 200");
});
test("rejects all reversed ranges",()=>{
 for(const prefix of ["price","year","registration_year","mileage","power"]){
  const result=parseMobileDeFilters({[`${prefix}_min`]:"2025",[`${prefix}_max`]:"2020"});
  assert.equal(result.valid,false,prefix);
  assert.ok(result.errors[`${prefix}_min` as keyof typeof result.errors]);
 }
});
test("rejects malformed numbers, duplicate params and unsupported sorting",()=>{
 for(const params of [{mileage_min:"1e4"},{year_min:"2020.5"},{price_min:"-1"},{make:["BMW","Audi"]},{sort:"random"},{model:"Golf"}])assert.equal(parseMobileDeFilters(params).valid,false);
});
test("new search drops old cursor and pagination preserves filters",()=>{
 const filters=parseMobileDeFilters({make:"BMW",price_min:"0",sort:"price_asc",cursor:"old/+=token"}).filters;
 assert.equal(mobileDeFilterParams(filters).has("cursor"),false);
 const next=mobileDeFilterParams(filters,"new/+=token");
 assert.equal(next.get("cursor"),"new/+=token");
 const restored=parseMobileDeFilters(Object.fromEntries(next));
 assert.equal(restored.filters.make,"BMW");
 assert.equal(restored.filters.price_min,"0");
 assert.equal(restored.filters.sort,"price_asc");
 assert.equal(restored.filters.cursor,"new/+=token");
});
