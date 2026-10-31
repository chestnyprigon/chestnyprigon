import assert from "node:assert/strict";
import test from "node:test";
import { mobileDeImageCandidates } from "./images";
const source="https://img.classistatic.de/api/v1/mo-prod/images/a4/photo-id?rule=mo-1600.jpg";
test("uses the same size rule syntax as the source, retaining original fallback",()=>{
 const thumbnails=mobileDeImageCandidates(source,"thumbnail");
 assert.equal(new URL(thumbnails[0]).searchParams.get("rule"),"mo-200");
 assert.equal(new URL(mobileDeImageCandidates(source,"main")[0]).searchParams.get("rule"),"mo-1024");
 assert.equal(new URL(mobileDeImageCandidates(source,"full")[0]).searchParams.get("rule"),"mo-1600");
 assert.equal(thumbnails.at(-1),source);
});
test("does not rewrite unrelated or malformed image URLs",()=>{
 for(const url of ["/photo.jpg","https://example.com/photo.jpg", "not a url"]){assert.deepEqual(mobileDeImageCandidates(url,"main"),[url]);}
});
