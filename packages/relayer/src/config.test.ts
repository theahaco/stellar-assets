import { Keypair } from "@stellar/stellar-sdk"
import { describe, expect, it } from "vitest"
import { findIssuerCollision, loadConfig } from "./config.js"

const SECRET = Keypair.random().secret()
const TOKEN = "long-enough-token-16"

const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
	RELAYER_SECRET: SECRET,
	RELAYER_API_TOKEN: TOKEN,
	...over,
})

describe("loadConfig — token and bind rules", () => {
	it("boots with a token on the default (non-loopback) bind", () => {
		const cfg = loadConfig(env())
		expect(cfg.apiToken).toBe(TOKEN)
		expect(cfg.host).toBe("0.0.0.0")
	})

	it("refuses a non-loopback bind without a token", () => {
		expect(() => loadConfig(env({ RELAYER_API_TOKEN: "" }))).toThrow(
			/non-loopback.*RELAYER_API_TOKEN/s,
		)
	})

	it("allows a loopback bind without a token (local development)", () => {
		const cfg = loadConfig(env({ RELAYER_API_TOKEN: "", HOST: "127.0.0.1" }))
		expect(cfg.apiToken).toBeUndefined()
		expect(cfg.host).toBe("127.0.0.1")
	})

	it("refuses a short token", () => {
		expect(() => loadConfig(env({ RELAYER_API_TOKEN: "short" }))).toThrow(
			/at least 16 characters/,
		)
	})

	it("flags a signer that is a pinned asset's issuer", () => {
		// loadConfig itself compares against the real registry, whose issuer
		// secrets we (rightly) do not have — so the collision predicate is
		// tested directly, plus the negative path through loadConfig.
		const issuer = Keypair.random().publicKey()
		const assets = [{ code: "EURCV", issuer }]
		expect(findIssuerCollision(issuer, assets)).toEqual(assets[0])
		expect(
			findIssuerCollision(Keypair.random().publicKey(), assets),
		).toBeUndefined()
		// A random key collides with no pinned issuer: boots fine.
		expect(() => loadConfig(env())).not.toThrow()
	})

	it("parses limit knobs and applies defaults", () => {
		const dflt = loadConfig(env())
		expect(dflt.rateLimitRpm).toBe(120)
		expect(dflt.maxInflight).toBe(8)
		expect(dflt.trustProxy).toBe(false)

		const tuned = loadConfig(
			env({ RATE_LIMIT_RPM: "0", MAX_INFLIGHT: "32", TRUST_PROXY: "1" }),
		)
		expect(tuned.rateLimitRpm).toBe(0)
		expect(tuned.maxInflight).toBe(32)
		expect(tuned.trustProxy).toBe(true)

		expect(() => loadConfig(env({ RATE_LIMIT_RPM: "-1" }))).toThrow(
			/RATE_LIMIT_RPM/,
		)
	})
})

describe("loadConfig — SEP-7 request signing", () => {
	it("signs as the relayer key by default, with the public URL derived from the domain", () => {
		const cfg = loadConfig(env({ SEP7_ORIGIN_DOMAIN: "relay.example" }))
		expect(cfg.sep7OriginDomain).toBe("relay.example")
		expect(cfg.sep7Signer.publicKey()).toBe(cfg.signer.publicKey())
		expect(cfg.sep7PublicUrl).toBe("https://relay.example")
		expect(cfg.sep7HandlerBase).toBe("https://authline.io/app.html")
	})

	it("accepts a dedicated signing key and explicit URLs; rejects malformed ones", () => {
		const k = Keypair.random()
		const cfg = loadConfig(
			env({
				SEP7_SIGNING_SECRET: k.secret(),
				SEP7_PUBLIC_URL: "http://127.0.0.1:8787/",
				SEP7_HANDLER_BASE: "http://localhost:4173/app.html",
			}),
		)
		expect(cfg.sep7Signer.publicKey()).toBe(k.publicKey())
		expect(cfg.sep7PublicUrl).toBe("http://127.0.0.1:8787")
		expect(cfg.sep7OriginDomain).toBeUndefined()
		expect(() =>
			loadConfig(env({ SEP7_ORIGIN_DOMAIN: "https://x.example" })),
		).toThrow(/bare domain/)
		expect(() => loadConfig(env({ SEP7_SIGNING_SECRET: "bad" }))).toThrow(
			/secret seed/,
		)
	})

	it("enables the callback on loopback by default, and by flag elsewhere", () => {
		expect(loadConfig(env()).allowSep7Callback).toBe(false)
		expect(loadConfig(env({ HOST: "127.0.0.1" })).allowSep7Callback).toBe(true)
		expect(
			loadConfig(env({ ALLOW_SEP7_CALLBACK: "1" })).allowSep7Callback,
		).toBe(true)
	})
})
