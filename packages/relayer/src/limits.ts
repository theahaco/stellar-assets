/**
 * In-process request limits for the relayer's /v1 routes. Both routes spend
 * the operator's RPC quota (and authorize spends XLM), so neither may be
 * free to call in a loop. The service is stateless by design, so per-process
 * in-memory limits are the right shape — an edge load balancer can add
 * stricter, shared limits in front without coordination.
 */

/** Decide per-key request budgets: a continuously refilling token bucket. */
export interface RateLimiter {
	/** Spend one token for `key`. False means over budget right now. */
	allow(key: string, now?: number): boolean
}

interface Bucket {
	tokens: number
	last: number
}

/**
 * One bucket per key (client IP), `rpm` tokens capacity, refilled evenly
 * over each minute. `rpm = 0` disables limiting. Stale buckets are pruned
 * opportunistically so an address scan cannot grow the map without bound.
 */
export function createRateLimiter(rpm: number): RateLimiter {
	const buckets = new Map<string, Bucket>()
	const perMs = rpm / 60_000

	function prune(now: number) {
		// A bucket refills completely in one minute; anything untouched for
		// two is indistinguishable from absent.
		for (const [k, b] of buckets) if (now - b.last > 120_000) buckets.delete(k)
	}

	return {
		allow(key, now = Date.now()) {
			if (rpm === 0) return true
			if (buckets.size > 10_000) prune(now)
			const b = buckets.get(key) ?? { tokens: rpm, last: now }
			b.tokens = Math.min(rpm, b.tokens + (now - b.last) * perMs)
			b.last = now
			if (b.tokens < 1) {
				buckets.set(key, b)
				return false
			}
			b.tokens -= 1
			buckets.set(key, b)
			return true
		},
	}
}

/** Cap concurrent in-flight work. `max = 0` disables the cap. */
export interface Gate {
	/** Try to enter; on success, MUST `leave()` exactly once when done. */
	enter(): boolean
	leave(): void
	readonly inflight: number
}

export function createGate(max: number): Gate {
	let inflight = 0
	return {
		enter() {
			if (max !== 0 && inflight >= max) return false
			inflight += 1
			return true
		},
		leave() {
			inflight = Math.max(0, inflight - 1)
		},
		get inflight() {
			return inflight
		},
	}
}
