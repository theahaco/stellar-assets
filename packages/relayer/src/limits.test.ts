import { describe, expect, it } from "vitest"
import { createGate, createRateLimiter } from "./limits.js"

describe("createRateLimiter", () => {
	it("grants rpm requests, then refuses until tokens refill", () => {
		const lim = createRateLimiter(3)
		const t0 = 1_000_000
		expect(lim.allow("ip", t0)).toBe(true)
		expect(lim.allow("ip", t0)).toBe(true)
		expect(lim.allow("ip", t0)).toBe(true)
		expect(lim.allow("ip", t0)).toBe(false)
		// One token refills in rpm=3 → 20 s.
		expect(lim.allow("ip", t0 + 21_000)).toBe(true)
		expect(lim.allow("ip", t0 + 21_000)).toBe(false)
	})

	it("keys are independent — one noisy IP cannot starve another", () => {
		const lim = createRateLimiter(1)
		const t0 = 0
		expect(lim.allow("a", t0)).toBe(true)
		expect(lim.allow("a", t0)).toBe(false)
		expect(lim.allow("b", t0)).toBe(true)
	})

	it("never grants more than the bucket capacity after a long idle", () => {
		const lim = createRateLimiter(2)
		expect(lim.allow("ip", 0)).toBe(true)
		// An hour idle must not bank an hour of tokens.
		expect(lim.allow("ip", 3_600_000)).toBe(true)
		expect(lim.allow("ip", 3_600_000)).toBe(true)
		expect(lim.allow("ip", 3_600_000)).toBe(false)
	})

	it("rpm=0 disables limiting", () => {
		const lim = createRateLimiter(0)
		for (let i = 0; i < 100; i++) expect(lim.allow("ip", 0)).toBe(true)
	})
})

describe("createGate", () => {
	it("admits up to max, refuses beyond, readmits after leave", () => {
		const gate = createGate(2)
		expect(gate.enter()).toBe(true)
		expect(gate.enter()).toBe(true)
		expect(gate.enter()).toBe(false)
		gate.leave()
		expect(gate.enter()).toBe(true)
		expect(gate.inflight).toBe(2)
	})

	it("max=0 disables the cap", () => {
		const gate = createGate(0)
		for (let i = 0; i < 50; i++) expect(gate.enter()).toBe(true)
	})
})
