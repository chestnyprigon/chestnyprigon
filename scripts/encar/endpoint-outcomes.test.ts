import assert from "node:assert/strict";
import test from "node:test";
import { classifyEndpointProbe, isEndpointCircuitBreaker, shouldRetryEndpoint } from "./endpoint-outcomes";

test("confirmed empty options are distinct from endpoint errors", () => {
  const empty = classifyEndpointProbe({ endpoint: "options", httpStatus: 200, payload: [] });
  assert.equal(empty.state, "confirmed_empty");
  assert.equal(empty.retryable, false);
  assert.equal(classifyEndpointProbe({ endpoint: "options", httpStatus: 200, payload: [{ optionName: "sunroof" }] }).state, "ok");
});

test("report absence requires an explicit source result", () => {
  assert.equal(classifyEndpointProbe({ endpoint: "insurance", httpStatus: 200, payload: { openData: false } }).state, "confirmed_unavailable");
  assert.equal(classifyEndpointProbe({ endpoint: "insurance", httpStatus: 404, payload: null }).state, "not_found");
  assert.equal(classifyEndpointProbe({ endpoint: "insurance", httpStatus: 200, payload: null }).state, "invalid_payload");
  assert.equal(classifyEndpointProbe({ endpoint: "inspection", httpStatus: 200, payload: { vehicleId: "123" }, canonicalId: "456" }).state, "identity_mismatch");
});

test("401 is a non-retryable auth error while transient failures get bounded retries", () => {
  const unauthorized = classifyEndpointProbe({ endpoint: "history", httpStatus: 401, error: new Error("HTTP 401"), attempts: 1 });
  assert.equal(unauthorized.state, "auth_error");
  assert.equal(unauthorized.retryable, false);
  assert.equal(shouldRetryEndpoint(unauthorized, 1, 3), false);

  const timeout = classifyEndpointProbe({ endpoint: "inspection", error: new Error("request timed out"), attempts: 1 });
  assert.equal(timeout.state, "transient_error");
  assert.equal(shouldRetryEndpoint(timeout, 1, 3), true);
  assert.equal(shouldRetryEndpoint(timeout, 3, 3), false);
});

test("HTTP 400 remains a request error, not a confirmed missing history", () => {
  const badRequest = classifyEndpointProbe({ endpoint: "history", httpStatus: 400, error: new Error("HTTP 400") });
  assert.equal(badRequest.state, "http_error");
  assert.equal(badRequest.retryable, false);
  assert.notEqual(badRequest.state, "not_found");
});

test("history availability distinguishes unavailable reports from malformed responses", () => {
  assert.equal(classifyEndpointProbe({ endpoint: "history_availability", httpStatus: 200, payload: { available: false } }).state, "confirmed_unavailable");
  assert.equal(classifyEndpointProbe({ endpoint: "history_availability", httpStatus: 200, payload: { available: true } }).state, "ok");
  assert.equal(classifyEndpointProbe({ endpoint: "history_availability", httpStatus: 200, payload: {} }).state, "invalid_payload");
});

test("diagnosis response must include the requested canonical vehicle ID and items", () => {
  assert.equal(classifyEndpointProbe({ endpoint: "diagnosis", httpStatus: 200, payload: { vehicleId: 123, items: [] }, canonicalId: "123" }).state, "ok");
  assert.equal(classifyEndpointProbe({ endpoint: "diagnosis", httpStatus: 200, payload: { vehicleId: 456, items: [] }, canonicalId: "123" }).state, "identity_mismatch");
  assert.equal(classifyEndpointProbe({ endpoint: "diagnosis", httpStatus: 200, payload: { vehicleId: 123 }, canonicalId: "123" }).state, "invalid_payload");
});

test("403 and 429 open the worker circuit breaker", () => {
  assert.equal(isEndpointCircuitBreaker(classifyEndpointProbe({ endpoint: "options", httpStatus: 403, error: new Error("HTTP 403") })), true);
  assert.equal(isEndpointCircuitBreaker(classifyEndpointProbe({ endpoint: "insurance", httpStatus: 429, error: new Error("HTTP 429") })), true);
  assert.equal(isEndpointCircuitBreaker(classifyEndpointProbe({ endpoint: "history", httpStatus: 401, error: new Error("HTTP 401") })), false);
});
