"""Minimal re-implementation of the Bambu/Prusa placeholder parser.

Supports what Bambu's machine templates use:
  [var]  [var[idx]]            legacy placeholders (vectors -> element of current extruder)
  {expr}                      expressions: + - * / % ( ) [] comparisons && || ! ==, strings
  {if c}..{elsif c}..{else}..{endif}
Floats are printed with %g like the C++ parser.
"""
from __future__ import annotations

import math
import re


class VList(list):
    """Vector option: out-of-range index falls back to element 0 (ConfigOption::get_at)."""

    def __getitem__(self, i):
        if isinstance(i, slice):
            return VList(super().__getitem__(i))
        i = int(i)
        if 0 <= i < len(self):
            return super().__getitem__(i)
        return super().__getitem__(0) if len(self) else 0


class Num(float):
    def __getitem__(self, i):
        return self


class INum(int):
    def __getitem__(self, i):
        return self


class Str(str):
    def __getitem__(self, i):
        if isinstance(i, (int, float)) and not isinstance(i, bool):
            return self
        return str.__getitem__(self, i)


def _typed(s: str):
    t = s.strip().strip('"')
    if re.fullmatch(r"[-+]?\d+", t):
        return INum(int(t))
    try:
        return Num(float(t[:-1] if t.endswith("%") else t))
    except ValueError:
        return Str(t)


def config_vars(config: dict[str, str]) -> dict:
    out = {}
    for k, v in config.items():
        if "\\n" in v or "{" in v:
            out[k] = Str(v)
            continue
        if ";" in v:
            out[k] = VList(_typed(p) for p in v.split(";"))
        elif "," in v and not re.search(r"[A-Za-z]{3,}", v.replace("x", "")):
            out[k] = VList(_typed(p) for p in v.split(","))
        else:
            out[k] = _typed(v)
    return out


def fmt(v) -> str:
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, int):
        return str(int(v))
    if isinstance(v, float):
        if math.isfinite(v) and v == int(v) and abs(v) < 1e15:
            return str(int(v))
        return "%g" % v
    return str(v)


_TOKEN = re.compile(r"\{|\[")


def _translate(expr: str) -> str:
    e = expr
    e = e.replace("&&", " and ").replace("||", " or ")
    e = re.sub(r"!(?!=)", " not ", e)
    e = re.sub(r"\btrue\b", "True", e)
    e = re.sub(r"\bfalse\b", "False", e)
    return e


class TemplateError(Exception):
    pass


def _eval(expr: str, env: dict):
    py = _translate(expr)
    names = {"min": min, "max": max, "int": int, "round": round, "abs": abs, "True": True, "False": False}
    try:
        return eval(py, {"__builtins__": {}}, _Env(env, names))
    except NameError as ex:
        raise TemplateError(f"unbekannte Variable in {{{expr}}}: {ex}") from None
    except Exception as ex:
        raise TemplateError(f"Fehler in {{{expr}}}: {ex}") from None


class _Env(dict):
    def __init__(self, env, extra):
        super().__init__()
        self.env = env
        self.extra = extra

    def __getitem__(self, k):
        if k in self.extra:
            return self.extra[k]
        if k in self.env:
            return self.env[k]
        raise NameError(k)


def _scan_brace(text: str, i: int, open_c: str, close_c: str) -> int:
    depth = 0
    in_str = False
    j = i
    while j < len(text):
        c = text[j]
        if in_str:
            if c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == open_c:
            depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return j
        j += 1
    raise TemplateError(f"nicht geschlossen ab Position {i}")


def _tokenize(text: str):
    toks = []
    i = 0
    while i < len(text):
        m = _TOKEN.search(text, i)
        if not m:
            toks.append(("text", text[i:]))
            break
        s = m.start()
        if s > i:
            toks.append(("text", text[i:s]))
        if text[s] == "{":
            e = _scan_brace(text, s, "{", "}")
            body = text[s + 1:e].strip()
            if body.startswith("if "):
                toks.append(("if", body[3:]))
            elif body.startswith("elsif "):
                toks.append(("elsif", body[6:]))
            elif body == "else":
                toks.append(("else", None))
            elif body == "endif":
                toks.append(("endif", None))
            else:
                toks.append(("expr", body))
            i = e + 1
        else:
            # legacy [var] - only if it looks like an identifier
            e = _scan_brace(text, s, "[", "]")
            body = text[s + 1:e]
            if re.fullmatch(r"[A-Za-z_]\w*(\[[^\]]+\])?", body.strip()):
                toks.append(("legacy", body.strip()))
            else:
                toks.append(("text", text[s:e + 1]))
            i = e + 1
    return toks


def _parse_block(toks, pos):
    """Returns (nodes, pos) until an else/elsif/endif at this level."""
    nodes = []
    while pos < len(toks):
        kind, val = toks[pos]
        if kind in ("elsif", "else", "endif"):
            return nodes, pos
        if kind == "if":
            branches = []
            cond = val
            pos += 1
            while True:
                body, pos = _parse_block(toks, pos)
                branches.append((cond, body))
                if pos >= len(toks):
                    raise TemplateError("{if} ohne {endif}")
                k2, v2 = toks[pos]
                if k2 == "elsif":
                    cond = v2
                    pos += 1
                elif k2 == "else":
                    cond = None
                    pos += 1
                elif k2 == "endif":
                    pos += 1
                    break
            nodes.append(("if", branches))
            continue
        nodes.append((kind, val))
        pos += 1
    return nodes, pos


def render(text: str, env: dict, current_extruder: int = 0) -> str:
    toks = _tokenize(text)
    nodes, pos = _parse_block(toks, 0)
    if pos != len(toks):
        raise TemplateError("unerwartetes else/endif")
    out: list[str] = []

    def run(ns):
        for kind, val in ns:
            if kind == "text":
                out.append(val)
            elif kind == "expr":
                out.append(fmt(_eval(val, env)))
            elif kind == "legacy":
                m = re.fullmatch(r"(\w+)(?:\[(.+)\])?", val)
                name, idx = m.group(1), m.group(2)
                if name not in env:
                    raise TemplateError(f"unbekannte Variable [{name}]")
                v = env[name]
                if idx is not None:
                    v = v[int(_eval(idx, env))]
                elif isinstance(v, VList):
                    v = v[current_extruder]
                out.append(fmt(v))
            elif kind == "if":
                for cond, body in val:
                    if cond is None or _eval(cond, env):
                        run(body)
                        break

    run(nodes)
    return "".join(out)
