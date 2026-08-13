/**
 * A tiny, dependency-free arithmetic expression evaluator for derived metrics.
 * It tokenizes, converts to RPN (shunting-yard), and evaluates by walking the
 * RPN with a numeric stack — it NEVER uses eval()/Function(), so user-entered
 * formulas cannot execute arbitrary code. Evaluation is element-wise: variables
 * resolve to a single bin's value, and the compiled form is reused per bin.
 */

type Tok =
  | { t: 'num'; v: number }
  | { t: 'var'; v: string }
  | { t: 'op'; v: string }
  | { t: 'fn'; v: string }
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'comma' };

const FUNCTIONS: Record<string, { arity: number; apply: (a: number[]) => number }> = {
  abs: { arity: 1, apply: (a) => Math.abs(a[0]) },
  sqrt: { arity: 1, apply: (a) => Math.sqrt(a[0]) },
  exp: { arity: 1, apply: (a) => Math.exp(a[0]) },
  ln: { arity: 1, apply: (a) => Math.log(a[0]) },
  log10: { arity: 1, apply: (a) => Math.log10(a[0]) },
  floor: { arity: 1, apply: (a) => Math.floor(a[0]) },
  ceil: { arity: 1, apply: (a) => Math.ceil(a[0]) },
  round: { arity: 1, apply: (a) => Math.round(a[0]) },
  sign: { arity: 1, apply: (a) => Math.sign(a[0]) },
  min: { arity: 2, apply: (a) => Math.min(a[0], a[1]) },
  max: { arity: 2, apply: (a) => Math.max(a[0], a[1]) },
  pow: { arity: 2, apply: (a) => a[0] ** a[1] },
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const PRECEDENCE: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 4, 'u-': 3 };
const RIGHT_ASSOC = new Set(['^', 'u-']);

function tokenize(src: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  const isDigit = (c: string) => c >= '0' && c <= '9';
  const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
  const isIdent = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n') {
      i++;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < src.length && (isDigit(src[j]) || src[j] === '.' || src[j] === 'e' || src[j] === 'E' ||
        ((src[j] === '+' || src[j] === '-') && (src[j - 1] === 'e' || src[j - 1] === 'E')))) {
        j++;
      }
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num)) throw new Error(`Invalid number "${src.slice(i, j)}"`);
      tokens.push({ t: 'num', v: num });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < src.length && isIdent(src[j])) j++;
      const name = src.slice(i, j);
      // A following '(' marks a function call; otherwise it is a variable/constant.
      let k = j;
      while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
      if (src[k] === '(') tokens.push({ t: 'fn', v: name });
      else tokens.push({ t: 'var', v: name });
      i = j;
      continue;
    }
    if ('+-*/%^'.includes(c)) {
      tokens.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ t: 'lp' });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ t: 'rp' });
      i++;
      continue;
    }
    if (c === ',') {
      tokens.push({ t: 'comma' });
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${c}"`);
  }
  return tokens;
}

/** Mark binary '-'/'+' vs unary by position, rewriting unary minus to 'u-'. */
function markUnary(tokens: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === 'op' && (tok.v === '-' || tok.v === '+')) {
      const prev = out[out.length - 1];
      const isUnary = !prev || prev.t === 'op' || prev.t === 'lp' || prev.t === 'comma';
      if (isUnary) {
        if (tok.v === '-') out.push({ t: 'op', v: 'u-' });
        // A leading unary '+' is a no-op; drop it.
        continue;
      }
    }
    out.push(tok);
  }
  return out;
}

interface RpnStep {
  kind: 'num' | 'var' | 'op' | 'fn';
  num?: number;
  name?: string;
}

function toRpn(tokens: Tok[]): RpnStep[] {
  const output: RpnStep[] = [];
  const stack: Tok[] = [];
  for (const tok of tokens) {
    switch (tok.t) {
      case 'num':
        output.push({ kind: 'num', num: tok.v });
        break;
      case 'var':
        output.push({ kind: 'var', name: tok.v });
        break;
      case 'fn':
        stack.push(tok);
        break;
      case 'comma':
        while (stack.length && stack[stack.length - 1].t !== 'lp') {
          output.push(opStep(stack.pop() as Tok));
        }
        if (!stack.length) throw new Error('Misplaced comma or missing parenthesis');
        break;
      case 'op': {
        while (stack.length) {
          const top = stack[stack.length - 1];
          if (top.t === 'op' && shouldPop(tok.v, top.v)) {
            output.push(opStep(stack.pop() as Tok));
          } else break;
        }
        stack.push(tok);
        break;
      }
      case 'lp':
        stack.push(tok);
        break;
      case 'rp': {
        while (stack.length && stack[stack.length - 1].t !== 'lp') {
          output.push(opStep(stack.pop() as Tok));
        }
        if (!stack.length) throw new Error('Mismatched parenthesis');
        stack.pop(); // discard the '('
        if (stack.length && stack[stack.length - 1].t === 'fn') {
          output.push(opStep(stack.pop() as Tok));
        }
        break;
      }
    }
  }
  while (stack.length) {
    const top = stack.pop() as Tok;
    if (top.t === 'lp' || top.t === 'rp') throw new Error('Mismatched parenthesis');
    output.push(opStep(top));
  }
  return output;
}

function shouldPop(cur: string, top: string): boolean {
  const p1 = PRECEDENCE[cur] ?? 0;
  const p2 = PRECEDENCE[top] ?? 0;
  return RIGHT_ASSOC.has(cur) ? p2 > p1 : p2 >= p1;
}

function opStep(tok: Tok): RpnStep {
  if (tok.t === 'op') return { kind: 'op', name: tok.v };
  if (tok.t === 'fn') return { kind: 'fn', name: tok.v };
  throw new Error('Unexpected token in output');
}

/** A compiled formula: the referenced variable names plus an element-wise eval. */
export interface CompiledExpression {
  /** Variable names referenced (excluding constants/functions). */
  vars: string[];
  /** Evaluate against a scope of variable→value; missing/NaN inputs yield NaN. */
  evaluate: (scope: Record<string, number>) => number;
}

/**
 * Compile a formula. `allowedVars` restricts which identifiers may be used as
 * variables; any other non-constant, non-function identifier throws. Returns
 * either a compiled expression or an error message.
 */
export function compileExpression(
  src: string,
  allowedVars: readonly string[],
): { ok: true; expr: CompiledExpression } | { ok: false; error: string } {
  try {
    if (!src.trim()) return { ok: false, error: 'Enter a formula.' };
    const allowed = new Set(allowedVars);
    const rpn = toRpn(markUnary(tokenize(src)));
    const used = new Set<string>();
    // Validate variables/functions up front.
    for (const step of rpn) {
      if (step.kind === 'var') {
        const name = step.name as string;
        if (name in CONSTANTS) continue;
        if (!allowed.has(name)) return { ok: false, error: `Unknown variable "${name}"` };
        used.add(name);
      } else if (step.kind === 'fn') {
        if (!(step.name! in FUNCTIONS)) return { ok: false, error: `Unknown function "${step.name}"` };
      }
    }
    const evaluate = (scope: Record<string, number>): number => {
      const st: number[] = [];
      for (const step of rpn) {
        if (step.kind === 'num') {
          st.push(step.num as number);
        } else if (step.kind === 'var') {
          const name = step.name as string;
          st.push(name in CONSTANTS ? CONSTANTS[name] : scope[name] ?? NaN);
        } else if (step.kind === 'op') {
          const op = step.name as string;
          if (op === 'u-') {
            const a = st.pop();
            st.push(a == null ? NaN : -a);
          } else {
            const b = st.pop();
            const a = st.pop();
            if (a == null || b == null) {
              st.push(NaN);
            } else {
              switch (op) {
                case '+': st.push(a + b); break;
                case '-': st.push(a - b); break;
                case '*': st.push(a * b); break;
                case '/': st.push(a / b); break;
                case '%': st.push(a % b); break;
                case '^': st.push(a ** b); break;
                default: st.push(NaN);
              }
            }
          }
        } else if (step.kind === 'fn') {
          const fn = FUNCTIONS[step.name as string];
          const args: number[] = [];
          for (let k = 0; k < fn.arity; k++) args.unshift(st.pop() ?? NaN);
          st.push(fn.apply(args));
        }
      }
      if (st.length !== 1) throw new Error('Malformed expression');
      return st[0];
    };
    // Probe once so a structurally-broken expression fails at compile time.
    const probe: Record<string, number> = {};
    for (const v of used) probe[v] = 1;
    evaluate(probe);
    return { ok: true, expr: { vars: [...used], evaluate } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Element-wise evaluation across aligned series. `series[name][i]` per bin. */
export function evaluateSeries(
  expr: CompiledExpression,
  series: Record<string, (number | null)[]>,
  length: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(length).fill(null);
  const scope: Record<string, number> = {};
  for (let i = 0; i < length; i++) {
    let ok = true;
    for (const name of expr.vars) {
      const v = series[name]?.[i];
      if (v == null || !Number.isFinite(v)) {
        ok = false;
        break;
      }
      scope[name] = v;
    }
    if (!ok) continue;
    const r = expr.evaluate(scope);
    out[i] = Number.isFinite(r) ? r : null;
  }
  return out;
}

/** First-difference (rate of change per bin) of a nullable series. */
export function rateOfChange(values: (number | null)[]): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1];
    const b = values[i];
    if (a != null && b != null && Number.isFinite(a) && Number.isFinite(b)) out[i] = b - a;
  }
  return out;
}

/** Centered-trailing simple moving average over a window of `n` bins. */
export function rollingMean(values: (number | null)[], n: number): (number | null)[] {
  const w = Math.max(1, Math.floor(n));
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - w + 1); j <= i; j++) {
      const v = values[j];
      if (v != null && Number.isFinite(v)) {
        sum += v;
        cnt++;
      }
    }
    if (cnt > 0) out[i] = sum / cnt;
  }
  return out;
}
