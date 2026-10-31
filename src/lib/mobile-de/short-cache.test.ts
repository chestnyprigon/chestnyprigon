import assert from "node:assert/strict";
import test from "node:test";
import { createShortCache } from "./short-cache";
test("hard TTL expires and consumers stay isolated",async()=>{
 let now=0,calls=0;const cache=createShortCache<number>(30_000,4,()=>now);const load=async()=>++calls;
 assert.equal(await cache("a",load),1);assert.equal(await cache("a",load),1);
 assert.equal(await cache("b",load),2);now=30_000;assert.equal(await cache("a",load),3);
});
test("parallel dictionary requests share a single upstream operation",async()=>{
 const cache=createShortCache<number>(30_000);let calls=0;
 const load=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return 42};
 assert.deepEqual(await Promise.all([cache("a",load),cache("a",load)]),[42,42]);assert.equal(calls,1);
});
test("failed calls are not cached and expired values are not served after failure",async()=>{
 let now=0;const cache=createShortCache<number>(30_000,4,()=>now);
 await cache("a",async()=>1);now=30_001;
 await assert.rejects(cache("a",async()=>{throw Error("unavailable")}));
 assert.equal(await cache("a",async()=>2),2);
});
