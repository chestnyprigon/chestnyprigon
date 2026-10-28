import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMobileDeFacets } from "./facets";

test("reads real singular facet keys and preserves case-sensitive API values", () => {
  const result = normalizeMobileDeFacets({api_version:"mobile-de-ru/v1",data:{
    make:[{value:"BMW",count:5108}],
    model:[{value:"116d",count:28},{value:"116D",count:4},{value:"116d",count:28}],
    fuel_type:[{value:"petrol",count:5}], transmission:[], body_type:[{value:"SUV",count:2}],
    ranges:{count:5108,power_min:105,power_max:156,year_min:null,year_max:null},
  }});
  assert.deepEqual(result.makes,["BMW"]);
  assert.deepEqual(result.models,["116d","116D"]);
  assert.deepEqual(result.fuel_types,["petrol"]);
  assert.deepEqual(result.transmissions,[]);
  assert.equal(result.ranges?.count,5108);
  assert.equal(result.ranges?.year_min,null);
});
test("missing dictionaries remain missing, never invented from other fields", () => {
  const result=normalizeMobileDeFacets({data:{make:[{value:"BMW",count:1}],model:[]}});
  assert.equal(result.fuel_types,undefined);
  assert.deepEqual(result.models,[]);
});
test("rejects malformed dictionary instead of silently showing empty selects", () => {
  for (const payload of [null,{}, {data:null}, {data:{model:{}}}, {data:{model:[{count:1}]}}, {data:{model:["BMW"]}}]) {
    assert.throws(()=>normalizeMobileDeFacets(payload));
  }
});

test("accepts null dictionaries in global and make-scoped API responses", () => {
  const global = normalizeMobileDeFacets({data:{make:[{value:"Audi",count:3116},{value:"BMW",count:2629}],model:null,fuel_type:null,transmission:null,body_type:null,ranges:{count:11477}}});
  assert.deepEqual(global.makes,["Audi","BMW"]);
  assert.equal(global.models,undefined);
  assert.equal(global.fuel_types,undefined);
  const scoped = normalizeMobileDeFacets({data:{make:null,model:[{value:"116d",count:28},{value:"116D",count:4}],fuel_type:[{value:"petrol",count:1}],transmission:[],body_type:[]}});
  assert.equal(scoped.makes,undefined);
  assert.deepEqual(scoped.models,["116d","116D"]);
  assert.deepEqual(scoped.fuel_types,["petrol"]);
});
