// Curated parameters for well-known facts that should never depend on a web scrape: platform fees and consumer VAT.
// An assumption created from one of these carries origin "reference" and the official source URL instead of a finding.
export interface KnownParameter {
	key: string
	text: string
	unit: string
	value: number
	/** ISO country the parameter applies to; absent = global. */
	country?: string
	source: string
	as_of: string
}

const STORE: KnownParameter[] = [
	{ key: "google_play_subscription_fee", text: "Google Play service fee on subscriptions (all subscription revenue)", unit: "%", value: 15, source: "https://support.google.com/googleplay/android-developer/answer/112622", as_of: "2024-01-01" },
	{ key: "google_play_iap_fee_first_1m", text: "Google Play service fee on one-time in-app purchases, first 1M USD per year", unit: "%", value: 15, source: "https://support.google.com/googleplay/android-developer/answer/112622", as_of: "2024-01-01" },
	{ key: "google_play_iap_fee", text: "Google Play service fee on one-time in-app purchases above 1M USD per year", unit: "%", value: 30, source: "https://support.google.com/googleplay/android-developer/answer/112622", as_of: "2024-01-01" },
	{ key: "apple_app_store_small_business_fee", text: "Apple App Store commission under the Small Business Program (under 1M USD per year)", unit: "%", value: 15, source: "https://developer.apple.com/app-store/small-business-program/", as_of: "2024-01-01" },
	{ key: "apple_app_store_fee", text: "Apple App Store standard commission (subscriptions drop to 15 % after the first year)", unit: "%", value: 30, source: "https://developer.apple.com/app-store/subscriptions/", as_of: "2024-01-01" },
]

// Standard VAT rates on digital services sold to consumers: charged in the buyer's country and taken out of the consumer price.
const VAT: Record<string, number> = { AT: 20, BA: 17, BE: 21, BG: 20, CH: 8.1, CZ: 21, DE: 19, DK: 25, ES: 21, FI: 25.5, FR: 20, GB: 20, GR: 24, HR: 25, HU: 27, IE: 23, IT: 22, ME: 21, MK: 18, NL: 21, NO: 25, PL: 23, PT: 23, RO: 19, RS: 20, SE: 25, SI: 22, SK: 23, TR: 20 }
const VAT_SOURCE = "https://taxation-customs.ec.europa.eu/taxation/vat/vat-directive/vat-rates_en"

export const PARAMETERS: readonly KnownParameter[] = [
	...STORE,
	...Object.entries(VAT).map(([country, value]) => ({ key: `vat_${country}`, text: `Standard VAT on digital sales to consumers in ${country} (deducted from the consumer price)`, unit: "%", value, country, source: VAT_SOURCE, as_of: "2025-01-01" })),
]

/** Global parameters plus the country-specific ones for the given countries (all countries when none given). */
export function knownParameters(countries?: readonly string[]): KnownParameter[] {
	const want = new Set((countries ?? []).map((c) => c.toUpperCase()))
	return PARAMETERS.filter((p) => !p.country || want.size === 0 || want.has(p.country))
}

export const parameterByKey = (key: string): KnownParameter | undefined => PARAMETERS.find((p) => p.key === key)
