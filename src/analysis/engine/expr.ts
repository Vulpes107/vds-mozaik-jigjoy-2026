// Tiny safe formula evaluator. LLM-supplied formulas (e.g. "as_001 * 1200 * (1 + as_003) ^ (year - 1) * 12")
// are parsed here and evaluated in code; no eval/Function is ever used.
//
// Grammar:  expr   := term (('+'|'-') term)*
//           term   := unary (('*'|'/') unary)*
//           unary  := '-' unary | power
//           power  := primary ('^' unary)?
//           primary:= number | ident | ident '(' expr (',' expr)* ')' | '(' expr ')'
// Functions: min, max, abs, cohort, ramp (see FUNCTIONS).   Variables: any identifier supplied in `vars`.

export type Vars = Readonly<Record<string, number>>

type Node =
	| { k: "num"; v: number }
	| { k: "var"; name: string }
	| { k: "neg"; a: Node }
	| { k: "bin"; op: "+" | "-" | "*" | "/" | "^"; a: Node; b: Node }
	| { k: "call"; fn: string; args: Node[] }

export interface Compiled {
	readonly source: string
	/** Distinct identifiers used as variables (function names excluded). */
	readonly identifiers: readonly string[]
	evaluate(vars: Vars): number
}

/**
 * Subscriber-months in calendar year `year` (1-based) for a paying cohort: `adds` new subscribers join every month
 * from the month after `launch` (months of build time before any revenue), and a fraction `churn` (0..1) of the
 * active base leaves each month. Revenue = cohort(...) * price per month. This is what makes churn and time to
 * market move the numbers instead of being listed and ignored.
 */
export function cohort(adds: number, churn: number, year: number, launch = 0): number {
	if (!(churn >= 0 && churn <= 1)) throw new Error(`cohort: churn must be a fraction 0..1 (got ${churn}; divide a percentage by 100)`)
	if (adds < 0 || launch < 0) throw new Error("cohort: adds and launch cannot be negative")
	const active = (k: number) => (k <= 0 ? 0 : churn === 0 ? adds * k : (adds * (1 - (1 - churn) ** k)) / churn)
	let total = 0
	for (let m = 12 * (year - 1) + 1; m <= 12 * year; m++) total += active(m - launch)
	return total
}

/** Fraction (0..1) of calendar year `year` that falls after `launch` months of build time; scales costs or sales that only start at launch. */
export function ramp(launch: number, year: number): number {
	return Math.max(0, Math.min(1, (12 * year - launch) / 12))
}

const FUNCTIONS: Record<string, { arity: [number, number]; fn: (xs: number[]) => number }> = {
	min: { arity: [1, 99], fn: (xs) => Math.min(...xs) },
	max: { arity: [1, 99], fn: (xs) => Math.max(...xs) },
	abs: { arity: [1, 1], fn: (xs) => Math.abs(xs[0] as number) },
	cohort: { arity: [3, 4], fn: (xs) => cohort(xs[0]!, xs[1]!, xs[2]!, xs[3]) },
	ramp: { arity: [2, 2], fn: (xs) => ramp(xs[0]!, xs[1]!) },
}

function tokenize(src: string): string[] {
	const tokens: string[] = []
	const re = /\s*(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+|[A-Za-z_][A-Za-z0-9_]*|[-+*/^(),])/y
	let pos = 0
	while (pos < src.length) {
		if (/^\s*$/.test(src.slice(pos))) break
		re.lastIndex = pos
		const m = re.exec(src)
		if (!m || m[1] === undefined) throw new Error(`Unexpected character at position ${pos} in formula "${src}"`)
		tokens.push(m[1])
		pos = re.lastIndex
	}
	return tokens
}

class Parser {
	private i = 0
	constructor(
		private readonly t: string[],
		private readonly src: string,
	) {}

	parse(): Node {
		if (this.t.length === 0) throw new Error("Empty formula")
		const n = this.expr()
		if (this.i < this.t.length) throw new Error(`Unexpected "${this.t[this.i]}" in formula "${this.src}"`)
		return n
	}
	private peek(): string | undefined {
		return this.t[this.i]
	}
	private take(): string {
		const tok = this.t[this.i++]
		if (tok === undefined) throw new Error(`Formula ended unexpectedly: "${this.src}"`)
		return tok
	}
	private expr(): Node {
		let a = this.term()
		while (this.peek() === "+" || this.peek() === "-") {
			const op = this.take() as "+" | "-"
			a = { k: "bin", op, a, b: this.term() }
		}
		return a
	}
	private term(): Node {
		let a = this.unary()
		while (this.peek() === "*" || this.peek() === "/") {
			const op = this.take() as "*" | "/"
			a = { k: "bin", op, a, b: this.unary() }
		}
		return a
	}
	private unary(): Node {
		if (this.peek() === "-") {
			this.take()
			return { k: "neg", a: this.unary() }
		}
		return this.power()
	}
	private power(): Node {
		const base = this.primary()
		if (this.peek() === "^") {
			this.take()
			return { k: "bin", op: "^", a: base, b: this.unary() }
		}
		return base
	}
	private primary(): Node {
		const tok = this.take()
		if (tok === "(") {
			const n = this.expr()
			if (this.take() !== ")") throw new Error(`Missing ")" in formula "${this.src}"`)
			return n
		}
		if (/^[\d.]/.test(tok)) {
			const v = Number(tok)
			if (!Number.isFinite(v)) throw new Error(`Bad number "${tok}" in formula "${this.src}"`)
			return { k: "num", v }
		}
		if (/^[A-Za-z_]/.test(tok)) {
			if (this.peek() === "(") {
				const f = FUNCTIONS[tok]
				if (!f) throw new Error(`Unknown function "${tok}" (allowed: ${Object.keys(FUNCTIONS).join(", ")})`)
				this.take()
				const args: Node[] = [this.expr()]
				while (this.peek() === ",") {
					this.take()
					args.push(this.expr())
				}
				if (this.take() !== ")") throw new Error(`Missing ")" after ${tok}( in formula "${this.src}"`)
				if (args.length < f.arity[0] || args.length > f.arity[1]) throw new Error(`${tok}() takes ${f.arity[0] === f.arity[1] ? f.arity[0] : `${f.arity[0]} to ${f.arity[1]}`} arguments in formula "${this.src}"`)
				return { k: "call", fn: tok, args }
			}
			return { k: "var", name: tok }
		}
		throw new Error(`Unexpected "${tok}" in formula "${this.src}"`)
	}
}

function collect(n: Node, out: Set<string>): void {
	switch (n.k) {
		case "var":
			out.add(n.name)
			return
		case "neg":
			collect(n.a, out)
			return
		case "bin":
			collect(n.a, out)
			collect(n.b, out)
			return
		case "call":
			n.args.forEach((a) => collect(a, out))
			return
		default:
			return
	}
}

function run(n: Node, vars: Vars, src: string): number {
	switch (n.k) {
		case "num":
			return n.v
		case "var": {
			const v = vars[n.name]
			if (v === undefined) throw new Error(`Unknown variable "${n.name}" in formula "${src}"`)
			return v
		}
		case "neg":
			return -run(n.a, vars, src)
		case "call":
			return FUNCTIONS[n.fn]!.fn(n.args.map((a) => run(a, vars, src)))
		case "bin": {
			const a = run(n.a, vars, src)
			const b = run(n.b, vars, src)
			switch (n.op) {
				case "+":
					return a + b
				case "-":
					return a - b
				case "*":
					return a * b
				case "/":
					if (b === 0) throw new Error(`Division by zero in formula "${src}"`)
					return a / b
				case "^":
					return a ** b
			}
		}
	}
}

export function compile(source: string): Compiled {
	const ast = new Parser(tokenize(source), source).parse()
	const ids = new Set<string>()
	collect(ast, ids)
	return {
		source,
		identifiers: [...ids],
		evaluate(vars) {
			const v = run(ast, vars, source)
			if (!Number.isFinite(v)) throw new Error(`Formula "${source}" did not produce a finite number`)
			return v
		},
	}
}

/** Accept a literal number or a formula string. */
export function compileValue(x: string | number): Compiled {
	return compile(typeof x === "number" ? String(x) : x)
}
