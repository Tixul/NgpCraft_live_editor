#!/usr/bin/env python3
"""
Offline validator for the C-to-JS transpile logic used by interpreter.js.
Re-implements compile() in Python so we can sanity-check the generated JS
without needing a browser/Node runtime.

Not a replacement for browser testing — JS regex semantics differ in places —
but catches obvious structural mistakes in the output before opening Firefox.
"""

import re
import sys
from pathlib import Path

TYPE_KEYWORDS = [
    'u_char', 'u_short', 'u_long',
    'u8', 'u16', 'u32', 's8', 's16', 's32',
    'char', 'short', 'int', 'long', 'bool', 'void',
]
TEMPLATE_TYPES = [
    'NgpcMetasprite', 'MsprPart', 'MsprAnimator', 'MsprAnimFrame',
    'FuncPtr', 'IntHandler',
]
STRUCT_DEFAULT_INIT_TYPES = ['MsprAnimator']
STORAGE_KEYWORDS = ['const', 'static', 'volatile', 'register', 'extern']
REGISTERS = {
    # Runtime externs
    'g_vb_counter':      (0xFB00, 8),
    'ngpc_pad_held':     (0xFB01, 8),
    'ngpc_pad_pressed':  (0xFB02, 8),
    'ngpc_pad_released': (0xFB03, 8),
    'ngpc_pad_repeat':   (0xFB04, 8),
    # K2GE (subset sufficient for the smoke test)
    'HW_JOYPAD':       (0x6F82, 8),
    'JOYPAD':          (0x6F82, 8),
    'HW_USR_SHUTDOWN': (0x6F85, 8),
    'USR_SHUTDOWN':    (0x6F85, 8),
    'HW_BG_CTL':       (0x8118, 8),
    'BG_COL':          (0x8118, 8),
    'HW_SCR_PRIO':     (0x8030, 8),
    'SCRL_PRIO':       (0x8030, 8),
    'HW_LCD_CTL':      (0x8012, 8),
}

PTR_TYPE_RE = re.compile(
    r'\*\s*\(\s*(?:volatile\s+)?(u8|u16|u32|u_char|u_short|u_long|s8|s16|s32|unsigned\s+char|unsigned\s+short|unsigned\s+long|char|short|int|long)\s*\*\s*\)\s*'
)

def type_width(t):
    x = re.sub(r'\s+', ' ', t).strip()
    if re.fullmatch(r'(u8|u_char|unsigned char|char|s8)', x): return 8
    if re.fullmatch(r'(u16|u_short|unsigned short|short|s16)', x): return 16
    if re.fullmatch(r'(u32|u_long|unsigned long|long|int|s32)', x): return 32
    return 8

def expand_user_macros(src):
    macros = []
    def save(match):
        full = match.group(0)
        lines = _count_lines(full)
        joined = re.sub(r'\\\r?\n\s*', ' ', full)
        m = re.match(r'^[ \t]*#define\s+(\w+)(\([^)]*\))?\s*(.*)$', joined)
        if m:
            name, params_raw, body = m.group(1), m.group(2), m.group(3)
            if params_raw is not None:
                params = [p.strip() for p in params_raw[1:-1].split(',') if p.strip()]
                macros.append({'name': name, 'params': params, 'body': body.strip(), 'fn': True})
            else:
                macros.append({'name': name, 'body': body.strip(), 'fn': False})
        return _blank_lines(lines)
    src = re.sub(r'^[ \t]*#define(?:[^\n]*\\\r?\n)*[^\n]*', save, src, flags=re.M)
    macros.sort(key=lambda m: -len(m['name']))
    for m in macros:
        if m['fn']:
            def fn_repl(match, macro=m):
                argsStr = match.group(1)
                args, depth, buf = [], 0, ''
                for ch in argsStr:
                    if ch == '(': depth += 1
                    elif ch == ')': depth -= 1
                    if ch == ',' and depth == 0:
                        args.append(buf.strip()); buf = ''
                    else:
                        buf += ch
                if buf.strip() or len(args) > 0:
                    args.append(buf.strip())
                body = macro['body']
                for i, p in enumerate(macro['params']):
                    a = args[i] if i < len(args) else ''
                    body = re.sub(rf'\b{p}\b', lambda _m, _a=a: _a, body)
                # Token pasting (C99 §6.10.3.3): `A ## B` joins tokens
                # post-substitution so NGP_TILEMAP_BLIT_SCR1(sym, base)
                # → sym_tiles / sym_map works as expected.
                body = re.sub(r'\s*##\s*', '', body)
                return body
            pat = re.compile(rf'\b{re.escape(m["name"])}\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)')
            src = pat.sub(fn_repl, src)
        else:
            body = re.sub(r'\s*##\s*', '', m['body'])
            src = re.sub(rf'\b{re.escape(m["name"])}\b', lambda _m, b=body: b, src)
    return src

def resolve_includes(src, resolver, seen=None, depth=0):
    if resolver is None: return src
    if seen is None: seen = set()
    if depth > 32: raise RuntimeError('include nested too deeply')
    def repl(m):
        name = m.group(1)
        if name in seen: return '\n'
        content = resolver(name)
        if content is None: return m.group(0)
        child = set(seen); child.add(name)
        inner = resolve_includes(content, resolver, child, depth + 1)
        return f'/* === begin include: {name} === */\n{inner}\n/* === end include: {name} === */'
    return re.sub(r'^[ \t]*#include\s+"([^"]+)"\s*$', repl, src, flags=re.MULTILINE)

def eval_conditionals(src):
    defines = {}
    # Each frame: [active, seen_true, has_else, parent_active]
    stack = [[True, True, False, True]]
    out = []

    def cur_active(): return stack[-1][0]

    def eval_expr(expr):
        e = re.sub(r'\bdefined\s*\(\s*(\w+)\s*\)', lambda m: '1' if m.group(1) in defines else '0', expr)
        e = re.sub(r'\bdefined\s+(\w+)', lambda m: '1' if m.group(1) in defines else '0', e)
        def sub_id(m):
            n = m.group(1)
            if n == 'true':  return '1'
            if n == 'false': return '0'
            if n in defines:
                body = defines[n]
                return body if body else '1'
            return '0'
        e = re.sub(r'\b([A-Za-z_]\w*)\b', sub_id, e)
        e = re.sub(r'\b(0[xX][0-9a-fA-F]+|\d+)[uUlL]+\b', r'\1', e)
        try:
            # Python eval is close enough for int arith / && / || — rewrite
            # C operators that differ.
            py = e.replace('&&', ' and ').replace('||', ' or ').replace('!', ' not ').replace(' not =', ' !=')
            # careful: the `!=` tokenization is tricky. Simpler: only eval if no '!'.
            py = e.replace('&&', ' and ').replace('||', ' or ')
            return bool(eval(py, {"__builtins__": {}}, {}))
        except Exception:
            return False

    for line in src.split('\n'):
        active = cur_active()
        m = re.match(r'^[ \t]*#\s*(if|ifdef|ifndef|elif|else|endif|define|undef)\b(.*)$', line)
        if not m:
            out.append(line if active else ''); continue
        d, rest = m.group(1), m.group(2)
        if d in ('if','ifdef','ifndef'):
            if active:
                if d == 'if':   val = eval_expr(rest)
                elif d == 'ifdef':   val = rest.strip().split()[0] in defines if rest.strip() else False
                else:                val = rest.strip() and rest.strip().split()[0] not in defines
            else:
                val = False
            stack.append([active and val, val, False, active])
            out.append('')
        elif d == 'elif':
            top = stack[-1]
            val = False
            if top[3] and not top[1]:
                val = eval_expr(rest)
                top[1] = top[1] or val
            top[0] = top[3] and val
            out.append('')
        elif d == 'else':
            top = stack[-1]
            top[2] = True
            top[0] = top[3] and not top[1]
            if top[0]: top[1] = True
            out.append('')
        elif d == 'endif':
            if len(stack) > 1: stack.pop()
            out.append('')
        elif d == 'define':
            if active:
                dm = re.match(r'^\s*(\w+)(?:\([^)]*\))?\s*(.*)$', rest)
                if dm: defines[dm.group(1)] = dm.group(2).strip()
                out.append(line)
            else:
                out.append('')
        elif d == 'undef':
            if active:
                un = rest.strip().split()[0] if rest.strip() else ''
                defines.pop(un, None)
                out.append(line)
            else:
                out.append('')
        else:
            out.append(line if active else '')
    return '\n'.join(out)

def hoist_function_statics(src, user_types):
    type_kws = ['u8','u16','u32','s8','s16','s32','u_char','u_short','u_long',
                'char','short','int','long','bool','void']
    all_types = type_kws + list(user_types)
    sig_re = re.compile(
        r'\b(?:static\s+)?(?:const\s+)?(?:(?:unsigned|signed)\s+)?'
        r'(?:' + '|'.join(all_types) + r')\b\s*\*?\s*(\w+)\s*\(([^)]*)\)\s*\{'
    )
    static_re = re.compile(
        r'\bstatic\s+((?:const\s+)?(?:(?:unsigned|signed)\s+)?'
        r'(?:' + '|'.join(all_types) + r')\b\s*\*?\s*)'
        r'(\w+)(\s*\[[^\]]*\])?\s*(?:=\s*([^;]+))?\s*;'
    )
    hoisted = []
    edits = []
    pos = 0
    for m in sig_re.finditer(src):
        fn = m.group(1)
        body_start = m.end()
        depth = 1; i = body_start
        while i < len(src) and depth > 0:
            c = src[i]
            if c == '{': depth += 1
            elif c == '}': depth -= 1
            i += 1
        body_end = i - 1
        body = src[body_start:body_end]
        found = static_re.findall(body)
        if not found: continue
        new_body = body
        for type_prefix, name, array_suffix, init in found:
            full_re = re.compile(r'\bstatic\s+(?:const\s+)?(?:(?:unsigned|signed)\s+)?(?:' + '|'.join(all_types) +
                                 r')\b\s*\*?\s*' + re.escape(name) + r'\s*(?:\[[^\]]*\])?\s*(?:=\s*[^;]+)?\s*;')
            new_body = full_re.sub(f'/* hoisted: static {name} */', new_body, count=1)
            new_body = re.sub(rf'\b{name}\b', f'__s_{fn}_{name}', new_body)
            if init:
                init_clause = ' = ' + init.strip()
            elif array_suffix:
                init_clause = ''
            else:
                init_clause = ' = 0'
            hoisted.append(f'{type_prefix.strip()} __s_{fn}_{name}{array_suffix}{init_clause};')
        edits.append((body_start, body_end, new_body))
    for s, e, rep in sorted(edits, reverse=True):
        src = src[:s] + rep + src[e:]
    if hoisted:
        src = '\n'.join(hoisted) + '\n' + src
    return src

def strip_preprocessor(src): return re.sub(r'^[ \t]*#.*$', '', src, flags=re.M)

def strip_inline_asm(src):
    keep = lambda m: '\n' * m.group(0).count('\n')
    src = re.sub(
        r'\b(?:__asm__|__asm|asm)\s*\(\s*(?:"(?:\\.|[^"\\])*"\s*(?::\s*[^)]*)?\s*)*\)\s*;?',
        keep, src,
    )
    src = re.sub(
        r'\b(?:_asm|__asm)\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}',
        keep, src,
    )
    return src
def _count_lines(s): return s.count('\n')
def _blank_lines(n): return '\n' * n
def strip_comments(src):
    src = re.sub(r'/\*[\s\S]*?\*/', lambda m: _blank_lines(_count_lines(m.group())), src)
    return re.sub(r'//[^\n]*', '', src)

def extract_user_types(src):
    names = set()
    for m in re.finditer(r'typedef\s+(?:struct|union|enum)(?:\s+\w+)?\s*\{[\s\S]*?\}\s*(\w+)\s*;', src):
        names.add(m.group(1))
    for m in re.finditer(r'typedef\s+[^;]+?\(\s*\*\s*(\w+)\s*\)[^;]*;', src):
        names.add(m.group(1))
    for m in re.finditer(r'typedef\s+(?:\w+\s+)+(\w+)\s*;', src):
        names.add(m.group(1))
    return names

def strip_int_literal_suffixes(src):
    return re.sub(r'\b(0[xX][0-9a-fA-F]+|\d+)[uUlL]+\b', r'\1', src)

def rewrite_char_literals(src):
    esc = {'n': 10, 'r': 13, 't': 9, '0': 0, 'a': 7, 'b': 8, 'f': 12, 'v': 11,
           "'": 39, '"': 34, '\\': 92, '?': 63}
    char_re = re.compile(r"^'(\\x[0-9a-fA-F]{1,2}|\\[^']|[^'\\])'")
    def replace(match):
        body = match[1:-1]
        if len(body) == 1: return str(ord(body))
        if body.startswith('\\x'): return str(int(body[2:], 16))
        c = body[1]
        return str(esc.get(c, ord(c)))
    out, i = [], 0
    while i < len(src):
        c = src[i]
        if c == '"':
            start = i; i += 1
            while i < len(src) and src[i] != '"':
                if src[i] == '\\' and i + 1 < len(src): i += 2
                else: i += 1
            if i < len(src): i += 1
            out.append(src[start:i]); continue
        if c == "'":
            m = char_re.match(src[i:])
            if m:
                out.append(replace(m.group(0)))
                i += len(m.group(0)); continue
        out.append(c); i += 1
    return ''.join(out)

def split_multi_var_decls(src, user_types):
    type_alt = '|'.join(list(TYPE_KEYWORDS) + list(user_types))
    storage_alt = '|'.join(STORAGE_KEYWORDS)
    pat = re.compile(
        r'(^|[;{\n\r])(\s*)'
        r'((?:(?:' + storage_alt + r')\s+)*(?:(?:unsigned|signed)\s+)?'
        r'(?:' + type_alt + r')\b\s*(?:\*\s*)?)'
        r'([A-Za-z_]\w*(?:\s*=\s*[^,;]+)?'
        r'(?:\s*,\s*[A-Za-z_]\w*(?:\s*=\s*[^,;]+)?)+)\s*;'
    )
    def repl(m):
        pre, ws, type_str, body = m.groups()
        items = []
        depth = 0
        buf = ''
        for ch in body:
            if ch in '([': depth += 1
            elif ch in ')]': depth -= 1
            if ch == ',' and depth == 0:
                items.append(buf.strip()); buf = ''
            else:
                buf += ch
        if buf.strip(): items.append(buf.strip())
        return pre + ws + ' '.join(f'{type_str}{it};' for it in items)
    return pat.sub(repl, src)

def strip_typedefs(src):
    while True:
        m = re.search(r'typedef\s+(?:struct|union|enum)(?:\s+\w+)?\s*\{', src)
        if not m: break
        i = m.end()
        depth = 1
        while i < len(src) and depth > 0:
            if src[i] == '{': depth += 1
            elif src[i] == '}': depth -= 1
            i += 1
        while i < len(src) and src[i] != ';': i += 1
        if i < len(src): i += 1
        removed = src[m.start():i]
        src = src[:m.start()] + _blank_lines(_count_lines(removed)) + src[i:]
    return re.sub(r'typedef[^;{]+;', '', src)

def rewrite_c_pointers(src):
    src = src.replace('->', '.')
    # `{` added so `{ &frame_0, 6 }` strips the address-of too.
    return re.sub(r'([(,={]\s*)&(?=[A-Za-z_])', r'\1', src)

def default_init_structs(src):
    if not STRUCT_DEFAULT_INIT_TYPES:
        return src
    type_alt = '|'.join(STRUCT_DEFAULT_INIT_TYPES)
    return re.sub(
        rf'\b({type_alt})\s+([A-Za-z_]\w*)\s*;',
        r'\1 \2 = {};',
        src,
    )

def strip_cc900_qualifiers(src):
    src = re.sub(r'\b__far\b|\b__near\b|\b__tiny\b', '', src)
    src = re.sub(r'\b__cdecl\b|\b__adecl\b', '', src)
    src = re.sub(r'\b__interrupt\b', '', src)
    src = re.sub(r'\b__regbank\s*\(\s*-?\d+\s*\)', '', src)
    src = re.sub(r'\bNGP_FAR\b|\bNGP_NEAR\b', '', src)
    return src

def rewrite_enums(src):
    def repl(m):
        full = m.group(0)
        body = m.group(1)
        entries = [s.strip() for s in body.split(',') if s.strip()]
        lines = []
        current = 0
        for e in entries:
            if '=' in e:
                name, _, val = e.partition('=')
                name, val = name.strip(), val.strip()
                lines.append(f'const {name} = ({val});')
                try: current = int(val, 0) + 1
                except Exception: current += 1
            else:
                lines.append(f'const {e} = {current};')
                current += 1
        return ' '.join(lines) + _blank_lines(_count_lines(full))
    return re.sub(r'(?:typedef\s+)?enum(?:\s+\w+)?\s*\{([^{}]*)\}\s*(\w+)?\s*;', repl, src)

def rewrite_sizeof(src):
    widths = {
        'u8':1,'u_char':1,'char':1,'signed char':1,'unsigned char':1,'s8':1,'bool':1,
        'u16':2,'u_short':2,'short':2,'signed short':2,'unsigned short':2,
        'int':2,'signed int':2,'unsigned int':2,'s16':2,
        'u32':4,'u_long':4,'long':4,'signed long':4,'unsigned long':4,'s32':4,
    }
    def repl(m):
        t = re.sub(r'\s+', ' ', m.group(1)).strip()
        if t.endswith('*'): return '4'
        return str(widths[t]) if t in widths else m.group(0)
    return re.sub(r'\bsizeof\s*\(\s*([a-zA-Z_][a-zA-Z0-9_\s*]*?)\s*\)', repl, src)

def type_bytes(t):
    # cc900 widths (T900_DENSE_REF.md §3): int == short == 2 bytes.
    x = re.sub(r'\s+', ' ', t).strip()
    if re.fullmatch(r'u8|u_char|unsigned char|char|s8', x): return 1
    if re.fullmatch(r'u16|u_short|unsigned short|short|s16|int|unsigned int|signed int', x): return 2
    if re.fullmatch(r'u32|u_long|unsigned long|long|signed long|s32', x): return 4
    return 1

def collect_pointers(src, user_types):
    type_alt = '|'.join(list(TYPE_KEYWORDS) + list(user_types))
    storage_alt = '|'.join(STORAGE_KEYWORDS)
    pat = re.compile(
        r'(?:^|[;{(,\n\r])\s*(?:(?:' + storage_alt + r')\s+)*'
        r'(?:(?:unsigned|signed)\s+)?(?:' + type_alt + r')\s*\*\s*([A-Za-z_]\w*)'
    )
    return {m.group(1) for m in pat.finditer(src)}

PTR_CAST_TYPES = r'u8|u16|u32|u_char|u_short|u_long|s8|s16|s32|unsigned\s+char|unsigned\s+short|unsigned\s+long|char|short|int|long'
PTR_CAST_RE = re.compile(r'\(\s*(?:volatile\s+)?(' + PTR_CAST_TYPES + r')\s*\*\s*\)\s*')

SCALAR_CAST_TYPES = (
    r'u8|u16|u32|s8|s16|s32|u_char|u_short|u_long|bool|void|char|short|int|long|'
    r'unsigned\s+char|unsigned\s+short|unsigned\s+long|unsigned\s+int|'
    r'signed\s+char|signed\s+short|signed\s+long|signed\s+int'
)
SCALAR_CAST_RE = re.compile(r'\(\s*(' + SCALAR_CAST_TYPES + r')\s*\)\s*')

def _type_wrap(t, expr):
    t = re.sub(r'\s+', ' ', t).strip()
    if t == 'void': return f'(({expr}), undefined)'
    signed = bool(re.match(r's8|s16|s32|char|short|int|long|signed', t))
    bits = type_bytes(t) * 8
    if bits == 32 and not signed: return f'(({expr}) >>> 0)'
    if bits == 32 and signed:     return f'(({expr}) | 0)'
    if bits == 16 and not signed: return f'(({expr}) & 0xFFFF)'
    if bits == 16 and signed:     return f'((({expr}) << 16) >> 16)'
    if not signed:                return f'(({expr}) & 0xFF)'
    return f'((({expr}) << 24) >> 24)'

def rewrite_scalar_casts(src):
    out, i = [], 0
    while i < len(src):
        rest = src[i:]
        m = SCALAR_CAST_RE.search(rest)
        if not m:
            out.append(rest); break
        out.append(rest[:m.start()]); i += m.start()
        after = rest[m.end():]
        expr, consumed = '', 0
        if after and after[0] == '(':
            depth, buf = 0, []
            for k, ch in enumerate(after):
                buf.append(ch)
                if ch == '(': depth += 1
                elif ch == ')':
                    depth -= 1
                    if depth == 0: consumed = k + 1; break
            expr = ''.join(buf)[1:-1].strip()
        elif after and after[0] in '-+~':
            mm = re.match(r'([A-Za-z_]\w*|0x[0-9A-Fa-f]+|\d+)', after[1:])
            if mm: expr = after[0] + mm.group(1); consumed = 1 + len(mm.group(1))
        else:
            mm = re.match(r'([A-Za-z_]\w*|0x[0-9A-Fa-f]+|\d+)', after)
            if mm:
                expr = mm.group(1); consumed = len(expr)
                if consumed < len(after) and after[consumed] == '(':
                    depth, buf = 0, []
                    for k in range(consumed, len(after)):
                        ch = after[k]; buf.append(ch)
                        if ch == '(': depth += 1
                        elif ch == ')':
                            depth -= 1
                            if depth == 0: consumed = k + 1; break
                    expr += ''.join(buf)
        if not expr:
            out.append(m.group(0)); i += m.end() - m.start()
            continue
        out.append(_type_wrap(m.group(1), expr))
        i += (m.end() - m.start()) + consumed
    return ''.join(out)

def rewrite_pointer_casts(src):
    out, i = [], 0
    while i < len(src):
        rest = src[i:]
        m = PTR_CAST_RE.search(rest)
        if not m:
            out.append(rest); break
        out.append(rest[:m.start()]); i += m.start()
        # skip if already part of a deref
        if out and out[-1] and out[-1][-1] == '*':
            out.append(rest[m.start():m.end()])
            i += m.end() - m.start()
            continue
        bytes_ = type_bytes(m.group(1))
        after = rest[m.end():]
        expr, consumed = '', 0
        if after and after[0] == '(':
            depth, buf = 0, []
            for k, ch in enumerate(after):
                buf.append(ch)
                if ch == '(': depth += 1
                elif ch == ')':
                    depth -= 1
                    if depth == 0: consumed = k + 1; break
            expr = ''.join(buf)[1:-1].strip()
        else:
            mm = re.match(r'([A-Za-z_]\w*|0x[0-9A-Fa-f]+|\d+)', after)
            if mm: expr = mm.group(1); consumed = len(expr)
        if expr:
            out.append(f'PTR({expr}, {bytes_})')
        else:
            out.append(m.group(0))
        i += (m.end() - m.start()) + consumed
    return ''.join(out)

INT_TYPES = {
    'u8': (8, False), 'u_char': (8, False),
    'u16':(16,False), 'u_short':(16,False),
    'u32':(32,False), 'u_long':(32,False),
    's8': (8, True ), 's16':(16,True ), 's32':(32,True ),
    'char':(8,True ), 'short':(16,True),
    'int':(16,True),  # cc900: int == short == 16-bit
    'long':(32,True),
}

def collect_int_var_widths(src, user_types):
    type_alt = '|'.join(INT_TYPES.keys())
    storage_alt = '|'.join(STORAGE_KEYWORDS)
    pat = re.compile(
        r'(?:^|[;{(,\n\r])\s*(?:(?:' + storage_alt + r')\s+)*(?:(unsigned|signed)\s+)?'
        r'(' + type_alt + r')\b\s+([A-Za-z_]\w*)(?!\s*\[)'
    )
    out = {}
    for m in pat.finditer(src):
        sign_mod, tname, vname = m.groups()
        bits, base_signed = INT_TYPES[tname]
        signed = (sign_mod == 'signed') if sign_mod else base_signed
        out[vname] = (bits, signed)
    return out

def wrap_int_expr(expr, info):
    bits, signed = info
    if bits == 32 and not signed: return f'(({expr}) >>> 0)'
    if bits == 32 and signed:     return f'(({expr}) | 0)'
    mask = '0xFFFF' if bits == 16 else '0xFF'
    if not signed: return f'(({expr}) & {mask})'
    shift = 32 - bits
    return f'((({expr}) << {shift}) >> {shift})'

def wrap_int_ops(src, int_map):
    # (?<!\.) guards each match so struct-field access `foo.x += …` isn't
    # treated as a tracked scalar named `x`. `->` was rewritten to `.` earlier.
    for name, info in int_map.items():
        n = re.escape(name)
        src = re.sub(
            rf'(?<!\.)(\b{n}\b\s*)=(?!=)(\s*)([^;]+);',
            lambda m: f'{m.group(1)}={m.group(2)}{wrap_int_expr(m.group(3), info)};',
            src,
        )
        src = re.sub(rf'(?<!\.)\b{n}\+\+|(?<!\.)\+\+{n}\b',
                     f'({name} = {wrap_int_expr(name + " + 1", info)})', src)
        src = re.sub(rf'(?<!\.)\b{n}--|(?<!\.)--{n}\b',
                     f'({name} = {wrap_int_expr(name + " - 1", info)})', src)
        src = re.sub(rf'(?<!\.)\b{n}\s*\+=\s*([^;]+);',
                     lambda m: f'{name} = {wrap_int_expr(f"{name} + ({m.group(1)})", info)};', src)
        src = re.sub(rf'(?<!\.)\b{n}\s*-=\s*([^;]+);',
                     lambda m: f'{name} = {wrap_int_expr(f"{name} - ({m.group(1)})", info)};', src)
    return src

def rewrite_pointer_ops(src, ptr_set):
    RHS = r'[A-Za-z_]\w*|0x[0-9A-Fa-f]+|\d+'
    def rhs_as_addr(rhs):
        if rhs in ptr_set: return f'{rhs}.addr'
        if rhs == 'NULL':  return '0'
        return rhs
    cmp_map = [('==', '==='), ('!=', '!=='), ('<=', '<='), ('>=', '>='), ('<', '<'), ('>', '>')]
    for name in ptr_set:
        n = re.escape(name)
        # Lvalue deref assign.
        src = re.sub(rf'\*\s*\b{n}\b\s*(?![+\-*/%&|^]?=)=\s*([^;]+);',
                     f'{name}[0] = \\1;', src)
        # Comparisons name <op> rhs / rhs <op> name.addr.
        for c_op, js_op in cmp_map:
            esc = re.escape(c_op)
            src = re.sub(
                rf'\b{n}\s*{esc}\s*({RHS})',
                lambda m: f'{name}.addr {js_op} {rhs_as_addr(m.group(1))}', src,
            )
            src = re.sub(
                rf'({RHS})\s*{esc}\s*\b{n}\.addr\b',
                lambda m: f'{rhs_as_addr(m.group(1))} {js_op} {name}.addr', src,
            )
        # Expression arithmetic p + N / p - N.
        src = re.sub(rf'\b{n}\s*\+\s*({RHS})(?!\+)',
                     lambda m: f'PADD({name}, ({m.group(1)}))', src)
        src = re.sub(rf'\b{n}\s*-\s*({RHS})(?!-)',
                     lambda m: f'PADD({name}, -({m.group(1)}))', src)
        # Increment / decrement.
        src = re.sub(rf'\b{n}\+\+|\+\+{n}\b', f'PINC({name}, 1)', src)
        src = re.sub(rf'\b{n}--|--{n}\b', f'PINC({name}, -1)', src)
        src = re.sub(rf'\b{n}\s*\+=\s*([^;]+);', f'PINC({name}, (\\1));', src)
        src = re.sub(rf'\b{n}\s*-=\s*([^;]+);', f'PINC({name}, -(\\1));', src)
        # Remaining rvalue deref.
        src = re.sub(rf'\*\s*\b{n}\b', f'{name}[0]', src)
    return src

def convert_init(src, start):
    j = start + 1
    while j < len(src) and src[j].isspace(): j += 1
    is_struct = j < len(src) and src[j] == '.'
    open_ch = '{' if is_struct else '['
    close_ch = '}' if is_struct else ']'
    body = []
    i = start + 1
    while i < len(src) and src[i] != '}':
        if src[i] == '{':
            inner, consumed = convert_init(src, i)
            body.append(inner)
            i += consumed
        elif is_struct and src[i] == '.':
            m = re.match(r'\.(\w+)\s*=', src[i:])
            if m:
                body.append(m.group(1) + ': ')
                i += m.end()
            else:
                body.append(src[i]); i += 1
        else:
            body.append(src[i]); i += 1
    i += 1
    return open_ch + ''.join(body) + close_ch, i - start

def rewrite_initializers(src):
    out = []
    i = 0
    while i < len(src):
        ch = src[i]
        prev = src[i-1] if i > 0 else ''
        nxt = src[i+1] if i+1 < len(src) else ''
        if ch == '=' and prev not in '=!<>' and nxt != '=':
            j = i + 1
            while j < len(src) and src[j].isspace(): j += 1
            if j < len(src) and src[j] == '{':
                out.append(src[i:j])
                converted, consumed = convert_init(src, j)
                out.append(converted)
                i = j + consumed
                continue
        out.append(ch); i += 1
    return ''.join(out)

def rewrite_array_inits(src):
    type_alt = '|'.join(TYPE_KEYWORDS)
    storage_alt = '|'.join(STORAGE_KEYWORDS)
    pat = re.compile(
        r'(^|[;{}\n\r])(\s*)(?:((?:' + storage_alt + r')\s+)+)?'
        r'(?:(?:unsigned|signed)\s+)?(?:' + type_alt + r')(?:\s*\*)?\s+'
        r'([A-Za-z_]\w*)\s*\[[^\]]*\]\s*=\s*\{([^{}]*)\}\s*;'
    )
    def repl(m):
        storage = m.group(3) or ''
        kw = 'const' if re.search(r'\bconst\b', storage) else 'let'
        return f'{m.group(1)}{m.group(2)}{kw} {m.group(4)} = [{m.group(5)}];'
    return pat.sub(repl, src)

def mark_derefs(src):
    out = []
    i = 0
    while i < len(src):
        rest = src[i:]
        m = PTR_TYPE_RE.search(rest)
        if not m:
            out.append(rest); break
        out.append(rest[:m.start()])
        i += m.start()
        width = type_width(m.group(1))
        after = rest[m.end():]
        expr = ''
        consumed = 0
        if after and after[0] == '(':
            depth = 0
            buf = ''
            for k, ch in enumerate(after):
                buf += ch
                if ch == '(': depth += 1
                elif ch == ')':
                    depth -= 1
                    if depth == 0:
                        consumed = k + 1
                        break
            expr = buf[1:-1].strip()
        else:
            mm = re.match(r'([A-Za-z_]\w*|0x[0-9A-Fa-f]+|\d+)', after)
            if mm:
                expr = mm.group(1)
                consumed = len(expr)
        out.append('__DEREF__{' + str(width) + '}__{' + (expr or '0') + '}__')
        i += (m.end() - m.start()) + consumed
    return ''.join(out)

def resolve_derefs(src):
    src = re.sub(
        r'__DEREF__\{(8|16|32)\}__\{([^}]*)\}__\s*=\s*([^;]+);',
        lambda m: f'W{m.group(1)}({m.group(2)}, {m.group(3)});',
        src,
    )
    return re.sub(
        r'__DEREF__\{(8|16|32)\}__\{([^}]*)\}__',
        lambda m: f'R{m.group(1)}({m.group(2)})',
        src,
    )

def strip_params(params, user_types=None):
    p = params.strip()
    if not p or re.fullmatch(r'void', p, re.I):
        return ''
    all_types = list(TYPE_KEYWORDS) + list(user_types or [])
    parts = []
    for raw in p.split(','):
        clean = re.sub(r'\b(?:' + '|'.join(STORAGE_KEYWORDS + ['unsigned', 'signed']) + r')\b', ' ', raw)
        clean = re.sub(r'\b(?:' + '|'.join(all_types) + r')\b', ' ', clean)
        clean = re.sub(r'[*\[\]]', ' ', clean).strip()
        toks = [t for t in clean.split() if t]
        if toks:
            parts.append(toks[-1])
    return ', '.join(parts)

def rewrite_functions(src, user_types):
    type_alt = '|'.join(list(TYPE_KEYWORDS) + list(user_types))
    storage_alt = '|'.join(STORAGE_KEYWORDS)
    pat = re.compile(
        r'(^|[;}\n\r])(\s*)(?:(?:' + storage_alt + r')\s+)?'
        r'(?:(?:unsigned|signed)\s+)?(?:' + type_alt + r')\b\s*(?:\*\s*)?'
        r'([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{'
    )
    return pat.sub(
        lambda m: f'{m.group(1)}{m.group(2)}function {m.group(3)}({strip_params(m.group(4), user_types)}) {{',
        src,
    )

def strip_extern_var_decls(src):
    type_kws = ['u8','u16','u32','s8','s16','s32','u_char','u_short','u_long',
                'char','short','int','long','bool','void']
    return re.sub(
        r'^[ \t]*extern\s+(?:const\s+)?(?:volatile\s+)?'
        r'(?:(?:unsigned|signed)\s+)?(?:' + '|'.join(type_kws) + r')\b\s*\*?\s*'
        r'[A-Za-z_]\w*\s*(?:\[[^\]]*\])?\s*;',
        '', src, flags=re.MULTILINE,
    )

def strip_function_prototypes(src, user_types):
    type_alt = '|'.join(TYPE_KEYWORDS + list(user_types))
    storage_alt = '|'.join(STORAGE_KEYWORDS)
    header_re = re.compile(
        r'(^|[;{}\n\r])(\s*)(?:(?:' + storage_alt + r')\s+)*'
        r'(?:(?:unsigned|signed)\s+)?(?:' + type_alt +
        r')\b\s*\*?\s*[A-Za-z_]\w*\s*\('
    )
    kills = []
    for m in header_re.finditer(src):
        open_idx = m.end() - 1
        depth, i = 1, open_idx + 1
        while i < len(src) and depth > 0:
            c = src[i]
            if c == '(': depth += 1
            elif c == ')': depth -= 1
            i += 1
        j = i
        while j < len(src) and src[j].isspace():
            j += 1
        if j >= len(src): continue
        if src[j] == '{': continue
        if src[j] == ';':
            keep_pre = len(m.group(1))
            kills.append((m.start() + keep_pre, j + 1))
    for s, e in sorted(kills, reverse=True):
        src = src[:s] + src[e:]
    return src

def rewrite_declarations(src, user_types):
    type_alt = '|'.join(list(TYPE_KEYWORDS) + list(user_types))
    storage_alt = '|'.join(STORAGE_KEYWORDS)
    pat = re.compile(
        r'(^|[;{(\n\r])(\s*)(?:(' + storage_alt + r')\s+)?'
        r'(?:(?:unsigned|signed)\s+)?(?:' + type_alt + r')\b\s*(?:\*\s*)?(?=[A-Za-z_])'
    )
    def repl(m):
        kw = 'const' if m.group(3) == 'const' else 'let'
        return f'{m.group(1)}{m.group(2)}{kw} '
    return pat.sub(repl, src)

def strip_array_sizes(src, user_types, _use_multi=True):
    type_alt = '|'.join(list(TYPE_KEYWORDS) + list(user_types))
    storage_alt = '|'.join(STORAGE_KEYWORDS)
    pat = re.compile(
        r'((?:(?:' + storage_alt + r')\s+)*(?:(?:unsigned|signed)\s+)?(?:'
        + type_alt + r')\b\s*(?:\*\s*)?[A-Za-z_]\w*)(?:\s*\[[^\]]*\])+(?=\s*=)'
    )
    return pat.sub(r'\1', src)

def downgrade_const_no_init(src):
    return re.sub(r'\bconst\s+([A-Za-z_]\w*)\s*;', r'let \1;', src)

def rewrite_vsync(src):
    src = re.sub(r'\bngpc_vsync\s*\(\s*\)\s*;', 'yield;', src)
    src = re.sub(
        r'\bngpc_sleep\s*\(([^;)]+)\)\s*;',
        r'{ for (let __sleep_i=0; __sleep_i < (\1); __sleep_i++) yield; }',
        src,
    )
    return src

def rewrite_debug_macros(src):
    src = re.sub(r'\bNGPC_ASSERT\s*\(([^;]+)\)\s*;',
                 r'if (!(\1)) ngpc_assert_fail("(source)", 0);', src)
    src = re.sub(r'\bNGPC_LOG_HEX\s*\(([^,]+),\s*([^)]+)\)\s*;',
                 r'ngpc_log_hex(\1, \2);', src)
    src = re.sub(r'\bNGPC_LOG_STR\s*\(([^,]+),\s*([^)]+)\)\s*;',
                 r'ngpc_log_str(\1, \2);', src)
    return src

def make_main_generator(src):
    return re.sub(r'\bfunction\s+main\s*\(\s*\)\s*\{', 'function* main() {', src)

def rewrite_registers(src):
    # Mark occurrences first (longest name first to avoid prefix collisions).
    names = sorted(REGISTERS.keys(), key=len, reverse=True)
    for name in names:
        addr, width = REGISTERS[name]
        src = re.sub(rf'\b{name}\b', f'__REG__{{{width}}}__{{{addr}}}__', src)
    mask = {'8': '0xFF', '16': '0xFFFF', '32': '0xFFFFFFFF'}
    def write_repl(m):
        w, addr, op, val = m.group(1), m.group(2), m.group(3), m.group(4)
        if op:
            return f'W{w}({addr}, (R{w}({addr}) {op} ({val})) & {mask[w]});'
        return f'W{w}({addr}, {val});'
    src = re.sub(
        r'__REG__\{(8|16|32)\}__\{(\d+)\}__\s*(\+|-|\*|/|%|&|\||\^|<<|>>)?=\s*([^;]+);',
        write_repl, src,
    )
    src = re.sub(
        r'__REG__\{(8|16|32)\}__\{(\d+)\}__',
        lambda m: f'R{m.group(1)}({m.group(2)})', src,
    )
    return src

def compile_c(src, include_resolver=None):
    src = strip_comments(src)
    if include_resolver:
        src = resolve_includes(src, include_resolver)
        src = strip_comments(src)
    src = eval_conditionals(src)
    has_vsync = bool(re.search(r'\bngpc_vsync\b', src)) or bool(re.search(r'\bngpc_sleep\s*\(', src))
    user_types = set(TEMPLATE_TYPES) | extract_user_types(src)
    src = hoist_function_statics(src, user_types)
    src = strip_extern_var_decls(src)
    src = strip_inline_asm(src)
    src = expand_user_macros(src)
    src = strip_preprocessor(src)
    src = strip_cc900_qualifiers(src)
    src = rewrite_enums(src)
    src = rewrite_sizeof(src)
    src = strip_typedefs(src)
    src = split_multi_var_decls(src, user_types)
    src = strip_int_literal_suffixes(src)
    src = rewrite_char_literals(src)
    src = rewrite_debug_macros(src)
    if has_vsync: src = rewrite_vsync(src)
    src = mark_derefs(src)
    src = resolve_derefs(src)
    src = rewrite_c_pointers(src)
    ptr_set = collect_pointers(src, user_types)
    int_map = collect_int_var_widths(src, user_types)
    src = rewrite_pointer_casts(src)
    src = rewrite_scalar_casts(src)
    src = strip_array_sizes(src, user_types)
    src = rewrite_initializers(src)
    src = default_init_structs(src)
    src = rewrite_functions(src, user_types)
    src = strip_function_prototypes(src, user_types)
    src = rewrite_declarations(src, user_types)
    src = downgrade_const_no_init(src)
    src = rewrite_pointer_ops(src, ptr_set)
    src = wrap_int_ops(src, int_map)
    src = rewrite_registers(src)
    if has_vsync: src = make_main_generator(src)
    return src

def main():
    starter = Path(__file__).parent / 'template' / 'src' / 'main.c'
    src = starter.read_text()
    print("=== starter main.c (transpiled) ===")
    out = compile_c(src)
    print(out)
    print()

    # Structural sanity checks.
    assert 'function* main(' in out, "main not rewritten to generator (vsync demo expected)"
    assert '__DEREF__' not in out, "leftover deref marker"
    assert '__REG__' not in out, "leftover register marker"
    assert 'ngpc_gfx_set_bg_color' in out, "high-level API call stripped"
    assert 'yield;' in out, "ngpc_vsync() not rewritten to yield"
    assert 'R8(64257)' in out, "ngpc_pad_held extern not rewritten"
    print("OK — structural checks pass.")

if __name__ == '__main__':
    try:
        main()
    except AssertionError as e:
        print(f"VALIDATION FAILED: {e}", file=sys.stderr)
        sys.exit(1)
