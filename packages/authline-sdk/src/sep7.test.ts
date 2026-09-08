import {
	Account,
	Address,
	Asset,
	BASE_FEE,
	Contract,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
	nativeToScVal,
	xdr,
} from "@stellar/stellar-sdk"
import { describe, expect, it } from "vitest"
import { onboardingRequest } from "./exchange.js"
import {
	describeSep7Tx,
	parseSep7TxRequest,
	postSep7Callback,
	sep7HandlerUrl,
	sep7Signer,
	signingKeyFromToml,
	verifySep7Signature,
} from "./sep7.js"

const NET = Networks.TESTNET
const HOLDER = Keypair.random().publicKey()
const SMART = "CDVVAQAQ4FKQ4DCPPIIOIAOPRJJBO6HVOXRQX3PXONJVJNNK432O6HW3"
const ROUTER = "CABVVUYHXS6UVN2VYYXKEUO2XEJIAGMTEYF2BOWGUUJVOO2IGPRWZAX4"
const SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"

/** The exact shape `buildOnboardTx` emits, built offline (no simulation). */
function onboardTx(holder: string, source = holder, withAuth = false): string {
	const op = new Contract(ROUTER).call(
		"onboard",
		new Address(SAC).toScVal(),
		new Address(holder).toScVal(),
	)
	const tx = new TransactionBuilder(new Account(source, "7"), {
		fee: BASE_FEE,
		networkPassphrase: NET,
	})
		.addOperation(op)
		.setTimeout(180)
		.build()
	if (!withAuth) return tx.toXDR()
	// Graft a smart-account address-credential auth entry onto the op, the
	// way simulation would for a contract holder.
	const env = tx.toEnvelope()
	const body = env.v1().tx().operations()[0].body().invokeHostFunctionOp()
	body.auth([
		new xdr.SorobanAuthorizationEntry({
			credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
				new xdr.SorobanAddressCredentials({
					address: new Address(holder).toScAddress(),
					nonce: xdr.Int64.fromString("1"),
					signatureExpirationLedger: 0,
					signature: nativeToScVal(null),
				}),
			),
			rootInvocation: new xdr.SorobanAuthorizedInvocation({
				function:
					xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
						new xdr.InvokeContractArgs({
							contractAddress: new Address(ROUTER).toScAddress(),
							functionName: "onboard",
							args: [new Address(SAC).toScVal(), new Address(holder).toScVal()],
						}),
					),
				subInvocations: [],
			}),
		}),
	])
	return env.toXDR("base64")
}

describe("parseSep7TxRequest", () => {
	it("round-trips what onboardingRequest emits", () => {
		const txXdr = onboardTx(HOLDER)
		const req = onboardingRequest({
			txXdr,
			networkPassphrase: NET,
			userAddress: HOLDER,
			msg: "Northwind: activate USDC",
			callback: "https://relay.example/v1/sep7/callback",
		})
		const parsed = parseSep7TxRequest(req.sep7Uri, { networkPassphrase: NET })
		expect(parsed.op).toBe("tx")
		expect(parsed.xdr).toBe(txXdr)
		expect(parsed.networkPassphrase).toBe(NET)
		expect(parsed.msg).toBe("Northwind: activate USDC")
		// `url:` namespace stripped — the value is ready to fetch.
		expect(parsed.callback).toBe("https://relay.example/v1/sep7/callback")
		// The signer is named explicitly — wallets must not guess it.
		expect(parsed.pubkey).toBe(HOLDER)
		expect(parsed.uri).toBe(req.sep7Uri)
	})

	it("rejects anything that is not a tx request", () => {
		expect(() => parseSep7TxRequest("https://example.com")).toThrow(
			/not a web\+stellar/,
		)
		expect(() =>
			parseSep7TxRequest(`web+stellar:pay?destination=${HOLDER}`),
		).toThrow(/pay/)
		expect(() => parseSep7TxRequest("web+stellar:tx?msg=hi")).toThrow(
			/no `xdr`/,
		)
		expect(() => parseSep7TxRequest("web+stellar:tx?xdr=AAAA")).toThrow(
			/not a transaction envelope/,
		)
	})

	it("refuses a request for another network before anything is decoded", () => {
		const req = onboardingRequest({
			txXdr: onboardTx(HOLDER),
			networkPassphrase: NET,
			userAddress: HOLDER,
		})
		expect(() =>
			parseSep7TxRequest(req.sep7Uri, { networkPassphrase: Networks.PUBLIC }),
		).toThrow(/another network/)
	})

	it("validates callback, pubkey, origin_domain and signature shapes", () => {
		const xdrB64 = encodeURIComponent(onboardTx(HOLDER))
		const base = `web+stellar:tx?xdr=${xdrB64}`
		expect(() =>
			parseSep7TxRequest(`${base}&callback=https%3A%2F%2Fx.example`),
		).toThrow(/url:/)
		expect(() =>
			parseSep7TxRequest(`${base}&callback=url%3Aftp%3A%2F%2Fx`),
		).toThrow(/http/)
		expect(() => parseSep7TxRequest(`${base}&pubkey=GABC`)).toThrow(/pubkey/)
		expect(() =>
			parseSep7TxRequest(`${base}&origin_domain=not%20a%20domain`),
		).toThrow(/origin_domain/)
		expect(() => parseSep7TxRequest(`${base}&signature=abc`)).toThrow(
			/origin_domain/,
		)
		expect(
			parseSep7TxRequest(`${base}&origin_domain=Northwind.Example`)
				.originDomain,
		).toBe("northwind.example")
	})
})

describe("verifySep7Signature", () => {
	const signer = Keypair.random()
	const signed = () =>
		onboardingRequest({
			txXdr: onboardTx(HOLDER),
			networkPassphrase: NET,
			userAddress: HOLDER,
			msg: "hello",
			originDomain: "northwind.example",
			signer,
		}).sep7Uri

	it("accepts a request signed by the published key", () => {
		expect(verifySep7Signature(signed(), signer.publicKey())).toBe(true)
	})

	it("rejects the wrong key, a tampered request, and a missing signature", () => {
		const uri = signed()
		expect(verifySep7Signature(uri, Keypair.random().publicKey())).toBe(false)
		expect(
			verifySep7Signature(
				uri.replace("msg=hello", "msg=hullo"),
				signer.publicKey(),
			),
		).toBe(false)
		expect(
			verifySep7Signature(
				uri.replace(/&signature=.*$/, ""),
				signer.publicKey(),
			),
		).toBe(false)
		expect(verifySep7Signature(uri, "not-a-key")).toBe(false)
	})
})

describe("signingKeyFromToml", () => {
	it("reads URI_REQUEST_SIGNING_KEY, quoted or bare", () => {
		const key = Keypair.random().publicKey()
		expect(
			signingKeyFromToml(`VERSION="2.0.0"\nURI_REQUEST_SIGNING_KEY="${key}"\n`),
		).toBe(key)
		expect(signingKeyFromToml(`URI_REQUEST_SIGNING_KEY = ${key}`)).toBe(key)
		expect(signingKeyFromToml(`SIGNING_KEY="${key}"`)).toBeNull()
		expect(signingKeyFromToml(`URI_REQUEST_SIGNING_KEY="GABC"`)).toBeNull()
	})
})

describe("describeSep7Tx", () => {
	it("recognises the router onboard shape and its signer", () => {
		const s = describeSep7Tx(onboardTx(HOLDER), NET)
		expect(s.onboard).toEqual({ router: ROUTER, sac: SAC, holder: HOLDER })
		expect(s.ops[0]).toMatchObject({
			type: "invokeHostFunction",
			contract: ROUTER,
			function: "onboard",
			args: [SAC, HOLDER],
			authorizers: [],
		})
		expect(s.signers).toEqual([HOLDER])
		expect(s.signatures).toBe(0)
		expect(s.feeBump).toBe(false)
		const req = parseSep7TxRequest(
			onboardingRequest({
				txXdr: onboardTx(HOLDER),
				networkPassphrase: NET,
				userAddress: HOLDER,
			}).sep7Uri,
		)
		expect(sep7Signer(req, s)).toBe(HOLDER)
	})

	it("lists the fee source AND the smart-account auth entry as signers", () => {
		const fee = Keypair.random().publicKey()
		const s = describeSep7Tx(onboardTx(SMART, fee, true), NET)
		expect(s.source).toBe(fee)
		expect(s.onboard?.holder).toBe(SMART)
		expect(s.ops[0].authorizers).toEqual([SMART])
		expect(s.signers).toEqual([fee, SMART])
		// The account the request wants: the onboarded holder, not the fee payer.
		const req = parseSep7TxRequest(
			`web+stellar:tx?xdr=${encodeURIComponent(onboardTx(SMART, fee, true))}`,
		)
		expect(sep7Signer(req, s)).toBe(SMART)
	})

	it("explains classic operations", () => {
		const issuer = Keypair.random().publicKey()
		const tx = new TransactionBuilder(new Account(HOLDER, "1"), {
			fee: BASE_FEE,
			networkPassphrase: NET,
		})
			.addOperation(Operation.changeTrust({ asset: new Asset("USDC", issuer) }))
			.setTimeout(30)
			.build()
		const s = describeSep7Tx(tx.toXDR(), NET)
		expect(s.onboard).toBeUndefined()
		expect(s.ops[0]).toMatchObject({ type: "changeTrust" })
		expect(s.ops[0].detail).toContain(`USDC:${issuer}`)
		expect(s.ops[0].asset).toEqual({ code: "USDC", issuer })
	})
})

describe("sep7Signer on a sponsored sandwich", () => {
	it("names the SPONSORED holder, never the sponsor that sources the envelope", () => {
		const sponsor = Keypair.random().publicKey()
		const issuer = Keypair.random().publicKey()
		const tx = new TransactionBuilder(new Account(sponsor, "1"), {
			fee: BASE_FEE,
			networkPassphrase: NET,
		})
			.addOperation(
				Operation.beginSponsoringFutureReserves({ sponsoredId: HOLDER }),
			)
			.addOperation(
				Operation.changeTrust({
					asset: new Asset("USDC", issuer),
					source: HOLDER,
				}),
			)
			.addOperation(Operation.endSponsoringFutureReserves({ source: HOLDER }))
			.setTimeout(30)
			.build()
		const s = describeSep7Tx(tx.toXDR(), NET)
		expect(s.ops[0].sponsored).toBe(HOLDER)
		const bare = parseSep7TxRequest(
			`web+stellar:tx?xdr=${encodeURIComponent(tx.toXDR())}`,
		)
		expect(sep7Signer(bare, s)).toBe(HOLDER)
		// And onboardingRequest says so explicitly via `pubkey`.
		tx.sign(Keypair.random()) // any signature: the guard wants the sponsor's
		const req = parseSep7TxRequest(
			onboardingRequest({
				txXdr: tx.toXDR(),
				networkPassphrase: NET,
				userAddress: HOLDER,
			}).sep7Uri,
		)
		expect(req.pubkey).toBe(HOLDER)
		expect(sep7Signer(req, s)).toBe(HOLDER)
	})
})

describe("postSep7Callback", () => {
	it("POSTs a form-encoded xdr field and returns the JSON answer", async () => {
		const calls: { url: string; init: RequestInit }[] = []
		const fetchImpl = (async (url: string, init: RequestInit) => {
			calls.push({ url, init })
			return new Response(JSON.stringify({ txHash: "abc" }), { status: 200 })
		}) as unknown as typeof fetch
		const r = await postSep7Callback(
			"https://relay.example/cb",
			"AAAA",
			fetchImpl,
		)
		expect(r.body).toEqual({ txHash: "abc" })
		expect(calls[0].url).toBe("https://relay.example/cb")
		expect(calls[0].init.method).toBe("POST")
		expect(
			(calls[0].init.headers as Record<string, string>)["content-type"],
		).toBe("application/x-www-form-urlencoded")
		expect(calls[0].init.body).toBe("xdr=AAAA")
	})

	it("surfaces a refusal with the callback's detail", async () => {
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ error: "x", detail: "not for me" }), {
				status: 400,
			})) as unknown as typeof fetch
		await expect(
			postSep7Callback("https://r/cb", "AAAA", fetchImpl),
		).rejects.toThrow(/400.*not for me/)
	})
})

describe("sep7HandlerUrl / handlerUrl handoff", () => {
	it("wraps the request for a hosted receiving page", () => {
		const req = onboardingRequest({
			txXdr: onboardTx(HOLDER),
			networkPassphrase: NET,
			userAddress: HOLDER,
			hostedBase: "https://onboard.example/app.html?x=1",
		})
		expect(req.handlerUrl).toBe(
			`https://onboard.example/app.html?sep7=${encodeURIComponent(req.sep7Uri)}`,
		)
		expect(
			sep7HandlerUrl("https://a.example/app.html#frag", "web+stellar:tx?xdr=A"),
		).toBe("https://a.example/app.html?sep7=web%2Bstellar%3Atx%3Fxdr%3DA")
		// The wrapped request parses back to the same thing.
		const inner = new URL(req.handlerUrl!).searchParams.get("sep7")!
		expect(parseSep7TxRequest(inner).xdr).toBe(onboardTx(HOLDER))
	})
})
