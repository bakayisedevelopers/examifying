const greek = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

const symbols = {
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  approx: '≈', equiv: '≡', in: '∈', notin: '∉', subset: '⊂', supset: '⊃', infty: '∞', partial: '∂', nabla: '∇',
  sum: '∑', prod: '∏', int: '∫', forall: '∀', exists: '∃', therefore: '∴', because: '∵', degree: '°', circ: '°',
  rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
  perpm: '⊥', parallel: '∥', angle: '∠', ell: 'ℓ', prime: '′', cdots: '⋯', ldots: '…', vdots: '⋮',
};

const superscript = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' };
const subscript = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ' };

const readGroup = (source, start) => {
  if (source[start] !== '{') return { value: source[start] || '', next: start + 1 };
  let depth = 1;
  let index = start + 1;
  for (; index < source.length && depth > 0; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
  }
  return { value: source.slice(start + 1, Math.max(start + 1, index - 1)), next: index };
};

const scriptText = (value, table, fallbackMarker = '^') => {
  const normalized = value.replace(/\\(?:mathrm|text|mathit|mathbf)\s*/g, '').replace(/[{}]/g, '').trim();
  const converted = [...normalized].map((character) => table[character]);
  return converted.every(Boolean) ? converted.join('') : `${fallbackMarker}(${normalized})`;
};

const parseTex = (source) => {
  let output = '';
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (character === '$') { index += 1; continue; }
    if (character === '{' || character === '}') { index += 1; continue; }
    if ((character === '^' || character === '_') && index + 1 < source.length) {
      let group;
      if (source[index + 1] === '{') group = readGroup(source, index + 1);
      else if (source[index + 1] === '\\') {
        const command = source.slice(index + 1).match(/^\\[A-Za-z]+/);
        group = command
          ? { value: command[0], next: index + 1 + command[0].length }
          : { value: source[index + 1], next: index + 2 };
      } else group = { value: source[index + 1], next: index + 2 };
      const parsed = parseTex(group.value);
      output += character === '^' && /^\\(?:circ|degree)$/.test(group.value)
        ? parsed
        : scriptText(parsed, character === '^' ? superscript : subscript, character);
      index = group.next;
      continue;
    }
    if (character === '\\') {
      if (source[index + 1] === '\\') { output += '\n'; index += 2; continue; }
      const commandMatch = source.slice(index + 1).match(/^([A-Za-z]+|.)/);
      if (!commandMatch) { index += 1; continue; }
      const command = commandMatch[1];
      index += command.length + 1;
      while (source[index] === ' ') index += 1;
      if (['frac', 'dfrac', 'tfrac'].includes(command)) {
        const numerator = readGroup(source, index); const denominator = readGroup(source, numerator.next);
        const top = parseTex(numerator.value).trim(); const bottom = parseTex(denominator.value).trim();
        output += `${/[\s+=−-]/.test(top) ? `(${top})` : top}⁄${/[\s+=−-]/.test(bottom) ? `(${bottom})` : bottom}`;
        index = denominator.next;
      } else if (command === 'sqrt') {
        let degree = '';
        if (source[index] === '[') {
          const close = source.indexOf(']', index + 1);
          if (close >= 0) { degree = parseTex(source.slice(index + 1, close)); index = close + 1; }
        }
        const radicand = readGroup(source, index);
        output += degree ? `${scriptText(degree, superscript)}√(${parseTex(radicand.value)})` : `√(${parseTex(radicand.value)})`;
        index = radicand.next;
      } else if (['text', 'mathrm', 'mathit', 'mathbf', 'operatorname', 'ce', 'overline', 'bar', 'vec', 'hat'].includes(command)) {
        const group = readGroup(source, index);
        const content = parseTex(group.value);
        const adornment = { overline: '\u0305', bar: '\u0305', vec: '\u20d7', hat: '\u0302' }[command] || '';
        output += adornment ? `${content}${adornment}` : content;
        index = group.next;
      } else if (command === ',') output += ' ';
      else if (command === '!') { /* TeX spacing command */ }
      else output += greek[command] || symbols[command] || (command.length === 1 ? command : command);
      continue;
    }
    if (character === '&') { output += '  '; index += 1; continue; }
    output += character;
    index += 1;
  }
  return output;
};

export const formatPeerWorkNotation = (text = '') => parseTex(String(text)
  .replace(/\\begin\{(?:aligned|align|array|cases|matrix|pmatrix|bmatrix)\}/g, '')
  .replace(/\\end\{(?:aligned|align|array|cases|matrix|pmatrix|bmatrix)\}/g, '')
  .replace(/\\\[|\\\]|\\\(|\\\)/g, '')
  .replace(/\\(?:quad|qquad|enspace|hspace\{[^}]*\})/g, ' ')
  .replace(/\*\*/g, '')
  .replace(/^\s*#{1,6}\s*/gm, '')
  .replace(/^\s*[-*]\s+/gm, '• '))
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

export const wrapPeerWorkText = (context, text, maxWidth) => {
  const lines = [];
  formatPeerWorkNotation(text).split(/\r?\n/).forEach((paragraph) => {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); return; }
    let line = '';
    words.forEach((word) => {
      if (context.measureText(word).width > maxWidth) {
        if (line) { lines.push(line); line = ''; }
        let fragment = '';
        [...word].forEach((character) => {
          if (fragment && context.measureText(`${fragment}${character}`).width > maxWidth) {
            lines.push(fragment);
            fragment = character;
          } else fragment += character;
        });
        line = fragment;
        return;
      }
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else line = candidate;
    });
    if (line) lines.push(line);
  });
  return lines;
};
