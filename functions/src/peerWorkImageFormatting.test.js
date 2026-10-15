import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPeerWorkNotation, wrapPeerWorkText } from './peerWorkImageFormatting.js';

test('renders common mathematics and science notation as visible text glyphs', () => {
  assert.equal(formatPeerWorkNotation('\\(x^{2} + \\frac{1}{2}\\)'), 'x² + 1⁄2');
  assert.equal(formatPeerWorkNotation('\\mathrm{H_2O} \\rightarrow \\Delta T = 3^\\circ C'), 'H₂O →ΔT = 3° C');
  assert.equal(formatPeerWorkNotation('\\sqrt{a^2 + b^2} = c'), '√(a² + b²) = c');
  assert.equal(formatPeerWorkNotation('v_{\\mathrm{max}} = 12 \\text{m s}^{-1}'), 'vₘₐₓ = 12 m s⁻¹');
});

test('wraps long equations to fit the generated work image width', () => {
  const context = { measureText: (value) => ({ width: [...value].length * 10 }) };
  const lines = wrapPeerWorkText(context, 'F = ma and x^{2} = 100', 90);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => context.measureText(line).width <= 90));
  assert.ok(lines.join(' ').includes('x²'));
});
