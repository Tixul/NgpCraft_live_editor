// Minimal C syntax highlighter for the live editor.
//
// Produces a string of `<span class="hl-*">` nodes from a raw C source. Not a
// full parser — a sequential regex walker that covers the common tokens. The
// HTML is rendered behind a transparent textarea so the user still gets a real
// editable text surface with a blinking caret and normal OS text selection.

const NGPC_Highlight = (() => {
  const C_KEYWORDS = new Set([
    'auto', 'break', 'case', 'const', 'continue', 'default', 'do', 'else',
    'enum', 'extern', 'for', 'goto', 'if', 'inline', 'register', 'restrict',
    'return', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union',
    'volatile', 'while', 'bool', 'true', 'false',
  ]);
  const C_TYPES = new Set([
    'void', 'char', 'short', 'int', 'long', 'signed', 'unsigned', 'float', 'double',
    'u8', 'u16', 'u32', 's8', 's16', 's32', 'u_char', 'u_short', 'u_long',
    'FuncPtr', 'IntHandler', 'size_t',
  ]);

  // Tokenizer rules in priority order. Each rule returns { len, html } or null.
  function escape(s) {
    return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  function tokenize(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const rest = src.slice(i);

      // Block comment
      let m = /^\/\*[\s\S]*?\*\//.exec(rest);
      if (m) { out.push(`<span class="hl-comment">${escape(m[0])}</span>`); i += m[0].length; continue; }

      // Line comment
      m = /^\/\/[^\n]*/.exec(rest);
      if (m) { out.push(`<span class="hl-comment">${escape(m[0])}</span>`); i += m[0].length; continue; }

      // Preprocessor line (#include, #define, etc.) — whole line
      m = /^#[^\n]*/.exec(rest);
      if (m) { out.push(`<span class="hl-preproc">${escape(m[0])}</span>`); i += m[0].length; continue; }

      // String literal (with basic escape tolerance)
      m = /^"(?:\\.|[^"\\])*"/.exec(rest);
      if (m) { out.push(`<span class="hl-string">${escape(m[0])}</span>`); i += m[0].length; continue; }

      // Char literal
      m = /^'(?:\\.|[^'\\])*'/.exec(rest);
      if (m) { out.push(`<span class="hl-string">${escape(m[0])}</span>`); i += m[0].length; continue; }

      // Hex, octal, decimal number (including optional suffix u/l/U/L)
      m = /^(?:0[xX][0-9A-Fa-f]+|0[0-7]+|\d+)[uUlL]*/.exec(rest);
      if (m) { out.push(`<span class="hl-number">${escape(m[0])}</span>`); i += m[0].length; continue; }

      // Identifier / keyword / type / function call
      m = /^[A-Za-z_]\w*/.exec(rest);
      if (m) {
        const word = m[0];
        // Peek next non-space char: if `(`, color as function.
        const afterIdx = i + word.length;
        let j = afterIdx;
        while (j < src.length && /\s/.test(src[j])) j++;
        const isCall = src[j] === '(';

        let cls = null;
        if (C_KEYWORDS.has(word)) cls = 'hl-keyword';
        else if (C_TYPES.has(word)) cls = 'hl-type';
        else if (isCall) cls = 'hl-func';

        if (cls) out.push(`<span class="${cls}">${escape(word)}</span>`);
        else     out.push(escape(word));
        i += word.length;
        continue;
      }

      // Punctuation / operator — single char fallback
      out.push(escape(src[i]));
      i++;
    }
    return out.join('');
  }

  return { tokenize };
})();

// Expose to globalThis so non-browser hosts (Node vm, Workers, electron) can
// access this binding — top-level `const` is otherwise script-scoped.
if (typeof globalThis !== 'undefined') globalThis.NGPC_Highlight = NGPC_Highlight;
