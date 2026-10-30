// Tiny safe formula evaluator. LLM-supplied formulas (e.g. "as_001 * 1200 * (1 + as_003) ^ (year - 1) * 12")
// are parsed here and evaluated in code; no eval/Function is ever used.
//
// Grammar:  expr   := term (('+'|'-') term)*
//           term   := unary (('*'|'/') unary)*
//           unary  := '-' unary | power
//           power  := primary ('^' unary)?
//           primary:= number | ident | ident '(' expr (',' expr)* ')' | '(' expr ')'
// Functions: min, max, abs.   Variables: any identifier supplied in `vars`.

export type Vars = Readonly<Record<string, number>>

type Node =
	| { k: "num"; v: number }
	| { k: "var"; name: string }
	| { k: "neg"; a: Node }
	| { k: "bin"; op: "+" | "-" | "*" | "/" | "^"; a: Node; b: Node }
	| { k: "call"; fn: "min" | "max" | "abs"; args: Node[] }

export interface Compiled {
	readonly source: string
	/** Distinct identifiers used as variables (function names excluded). */
	readonly identifiers: readonly string[]
	evaluate(vars: Vars): number
}

const FUNCTIONS = new Set(["min", "max", "abs"])

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
				if (!FUNCTIONS.has(tok)) throw new Error(`Unknown function "${tok}" (allowed: min, max, abs)`)
				this.take()
				const args: Node[] = [this.expr()]
				while (this.peek() === ",") {
					this.take()
					args.push(this.expr())
				}
				if (this.take() !== ")") throw new Error(`Missing ")" after ${tok}( in formula "${this.src}"`)
				return { k: "call", fn: tok as "min" | "max" | "abs", args }
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
		case "call": {
			const xs = n.args.map((a) => run(a, vars, src))
			if (n.fn === "abs") return Math.abs(xs[0] as number)
			return n.fn === "min" ? Math.min(...xs) : Math.max(...xs)
		}
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
