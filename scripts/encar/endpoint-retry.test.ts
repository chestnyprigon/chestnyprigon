import assert from "node:assert/strict";
import test from "node:test";
import { requestEndpointWithRetry } from "./endpoint-retry";
test("temporary endpoint errors make exactly three paced attempts and retain a technical outcome",async()=>{
  let calls=0;const pauses:number[]=[];
  const r=await requestEndpointWithRetry({endpoint:"insurance",canonicalId:"123",maxAttempts:99,
    probe:async()=>{calls++;return {httpStatus:503};},wait:async ms=>{pauses.push(ms);}});
  assert.equal(calls,3);assert.deepEqual(pauses,[10000,20000]);assert.equal(r.state,"transient_error");assert.equal(r.attempts,3);
});
test("auth, blocked, rate limit and confirmed missing reports never repeat",async()=>{
  for(const status of [401,403,429,404]) {
    let calls=0;const r=await requestEndpointWithRetry({endpoint:"insurance",canonicalId:"123",
      probe:async()=>{calls++;return {httpStatus:status};},wait:async()=>{throw Error("unexpected wait");}});
    assert.equal(calls,1);assert.notEqual(r.state,"confirmed_unavailable");
  }
});
test("a successful retry validates the canonical response and preserves request provenance",async()=>{
  const r=await requestEndpointWithRetry({endpoint:"inspection",canonicalId:"123",probe:async n=>n===1?{httpStatus:500}:{httpStatus:200,payload:{vehicleId:123}},wait:async()=>{}});
  assert.equal(r.state,"ok");assert.equal(r.attempts,2);assert.equal(r.requestedCanonicalId,"123");
});
