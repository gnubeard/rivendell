// syntax.js — lightweight syntax highlighter for fenced code blocks.
// Input: raw (unescaped) code string + language hint.
// Output: HTML string with token <span>s; all text is HTML-escaped.
// Pure; no DOM, no globals; unit-testable under Node.

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sp(cls, text) {
  return `<span class="${cls}">${esc(text)}</span>`;
}

// tokenize scans `code` left-to-right applying the first matching sticky rule.
// Each rule: { re (sticky), cls (string | null = no span), fn (optional, fn(match)→html) }
function tokenize(code, rules) {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    let matched = false;
    for (const r of rules) {
      r.re.lastIndex = i;
      const m = r.re.exec(code);
      if (m !== null) {
        out += r.fn ? r.fn(m[0]) : r.cls ? sp(r.cls, m[0]) : esc(m[0]);
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) out += esc(code[i++]);
  }
  return out;
}

// idRule: match an identifier (optionally requiring a following `(` for fn-call detection).
function idRule(kwSet, biSet, fnCall) {
  return {
    re: fnCall
      ? /[a-zA-Z_$][a-zA-Z0-9_$]*(?=[ \t]*\()/y
      : /[a-zA-Z_$][a-zA-Z0-9_$]*/y,
    fn(m) {
      if (kwSet.has(m)) return sp("hl-kw", m);
      if (biSet.has(m)) return sp("hl-bi", m);
      return fnCall ? sp("hl-fn", m) : esc(m);
    },
  };
}

function clikeRules(kw, bi) {
  const kwSet = new Set(kw);
  const biSet = new Set(bi);
  return [
    { re: /\/\/[^\n]*/y, cls: "hl-cm" },
    { re: /\/\*[\s\S]*?\*\//y, cls: "hl-cm" },
    { re: /"(?:[^"\\]|\\.)*"/y, cls: "hl-str" },
    { re: /'(?:[^'\\]|\\.)*'/y, cls: "hl-str" },
    { re: /`(?:[^`\\]|\\.)*`/y, cls: "hl-str" },
    { re: /0[xXbBoO][0-9a-fA-F_]+[lLuU]*/y, cls: "hl-num" },
    { re: /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFdDlLuU]*/y, cls: "hl-num" },
    idRule(kwSet, biSet, true),
    idRule(kwSet, biSet, false),
  ];
}

// --- Language keyword/builtin lists ---

const JS_KW = ["break","case","catch","class","const","continue","debugger","default",
  "delete","do","else","export","extends","finally","for","function","if","import",
  "in","instanceof","let","new","of","return","static","super","switch","this",
  "throw","try","typeof","var","void","while","with","yield","async","await","from",
  "as","abstract","declare","enum","implements","interface","namespace","override",
  "private","protected","public","readonly","type","keyof","infer","satisfies","null",
  "undefined","true","false"];

const JS_BI = ["NaN","Infinity","globalThis","console","Math","JSON","Object","Array",
  "String","Number","Boolean","Symbol","BigInt","Promise","Set","Map","WeakMap",
  "WeakSet","Error","TypeError","RangeError","ReferenceError","SyntaxError","Date",
  "RegExp","Proxy","Reflect","parseInt","parseFloat","isNaN","isFinite","encodeURI",
  "decodeURI","encodeURIComponent","decodeURIComponent","fetch","setTimeout",
  "clearTimeout","setInterval","clearInterval","queueMicrotask","requestAnimationFrame",
  "document","window","navigator","location","history","self","globalThis","process",
  "require","module","exports","__dirname","__filename"];

const PY_KW = ["False","None","True","and","as","assert","async","await","break",
  "class","continue","def","del","elif","else","except","finally","for","from",
  "global","if","import","in","is","lambda","nonlocal","not","or","pass","raise",
  "return","try","while","with","yield"];

const PY_BI = ["abs","all","any","bin","bool","bytes","callable","chr","classmethod",
  "compile","complex","delattr","dict","dir","divmod","enumerate","eval","exec",
  "filter","float","format","frozenset","getattr","globals","hasattr","hash","help",
  "hex","id","input","int","isinstance","issubclass","iter","len","list","locals",
  "map","max","memoryview","min","next","object","oct","open","ord","pow","print",
  "property","range","repr","reversed","round","set","setattr","slice","sorted",
  "staticmethod","str","sum","super","tuple","type","vars","zip",
  "NotImplemented","Ellipsis","__name__","__file__","__doc__","__package__",
  "Exception","ValueError","TypeError","KeyError","IndexError","AttributeError",
  "ImportError","OSError","IOError","StopIteration","GeneratorExit","RuntimeError",
  "self","cls"];

const GO_KW = ["break","case","chan","const","continue","default","defer","else",
  "fallthrough","for","func","go","goto","if","import","interface","map","package",
  "range","return","select","struct","switch","type","var","nil","true","false","iota"];

const GO_BI = ["any","bool","byte","complex64","complex128","comparable","error",
  "float32","float64","int","int8","int16","int32","int64","rune","string","uint",
  "uint8","uint16","uint32","uint64","uintptr","append","cap","clear","close","copy",
  "delete","len","make","max","min","new","panic","print","println","real","recover",
  "imag","complex"];

const RUST_KW = ["as","async","await","break","const","continue","crate","dyn","else",
  "enum","extern","false","fn","for","if","impl","in","let","loop","match","mod",
  "move","mut","pub","ref","return","self","Self","static","struct","super","trait",
  "true","type","unsafe","use","where","while","macro_rules","yield"];

const RUST_BI = ["bool","char","f32","f64","i8","i16","i32","i64","i128","isize",
  "u8","u16","u32","u64","u128","usize","str","String","Vec","Option","Result",
  "Some","None","Ok","Err","Box","Rc","Arc","Cell","RefCell","Mutex","RwLock",
  "Drop","Clone","Copy","Debug","Display","Default","Send","Sync","Iterator",
  "IntoIterator","From","Into","AsRef","AsMut","PartialEq","Eq","PartialOrd","Ord",
  "Hash","println","print","eprintln","eprint","format","panic","assert","assert_eq",
  "assert_ne","todo","unimplemented","unreachable","dbg","vec","write","writeln"];

const JAVA_KW = ["abstract","assert","boolean","break","byte","case","catch","char",
  "class","const","continue","default","do","double","else","enum","extends","final",
  "finally","float","for","goto","if","implements","import","instanceof","int",
  "interface","long","native","new","package","private","protected","public","return",
  "short","static","strictfp","super","switch","synchronized","this","throw","throws",
  "transient","try","var","void","volatile","while","record","sealed","permits",
  "true","false","null"];

const JAVA_BI = ["String","Integer","Long","Double","Float","Boolean","Byte","Short",
  "Character","Object","Class","Math","System","Runtime","StringBuilder","StringBuffer",
  "List","ArrayList","LinkedList","Map","HashMap","TreeMap","Set","HashSet","TreeSet",
  "Optional","Stream","Collectors","Arrays","Collections","Thread","Runnable",
  "Exception","RuntimeException","IllegalArgumentException","NullPointerException",
  "Override","SuppressWarnings","Deprecated","FunctionalInterface","Override"];

const C_KW = ["auto","break","case","char","const","continue","default","do","double",
  "else","enum","extern","float","for","goto","if","inline","int","long","register",
  "restrict","return","short","signed","sizeof","static","struct","switch","typedef",
  "union","unsigned","void","volatile","while","class","delete","new","namespace",
  "template","typename","virtual","override","final","public","protected","private",
  "explicit","noexcept","constexpr","consteval","constinit","decltype","using",
  "static_assert","throw","try","catch","operator","friend","mutable","this",
  "nullptr","true","false","NULL","alignas","alignof","co_await","co_return",
  "co_yield","concept","requires","export","import","module"];

const C_BI = ["bool","int8_t","int16_t","int32_t","int64_t","uint8_t","uint16_t",
  "uint32_t","uint64_t","size_t","ptrdiff_t","intptr_t","uintptr_t","ssize_t",
  "FILE","EOF","stdin","stdout","stderr","printf","fprintf","sprintf","snprintf",
  "scanf","fscanf","sscanf","malloc","calloc","realloc","free","memcpy","memmove",
  "memset","strlen","strcpy","strncpy","strcmp","strncmp","strcat","strncat",
  "fopen","fclose","fread","fwrite","fgets","fputs","assert","static_assert",
  "std","cout","cin","cerr","endl","string","vector","map","set","pair","tuple",
  "shared_ptr","unique_ptr","make_shared","make_unique","move","forward","declval"];

const RUBY_KW = ["BEGIN","END","alias","and","begin","break","case","class","def",
  "defined","do","else","elsif","end","ensure","false","for","if","in","module",
  "next","nil","not","or","redo","rescue","retry","return","self","super","then",
  "true","undef","unless","until","when","while","yield","__callee__","__dir__",
  "__method__","__FILE__","__LINE__","__ENCODING__"];

const RUBY_BI = ["puts","print","p","pp","gets","require","require_relative","load",
  "raise","fail","warn","exit","abort","sleep","rand","srand","Integer","Float",
  "String","Array","Hash","Symbol","Proc","Lambda","Kernel","Object","BasicObject",
  "Module","Class","Enumerable","Comparable","IO","File","Dir","Pathname","Time",
  "Range","Regexp","NilClass","TrueClass","FalseClass","Numeric","Integer","Float",
  "attr_accessor","attr_reader","attr_writer","include","extend","prepend",
  "private","protected","public","initialize","new","send","respond_to"];

// SQL uses uppercase keywords; we'll uppercase the code for matching.
const SQL_KW = new Set(["SELECT","FROM","WHERE","JOIN","LEFT","RIGHT","INNER","OUTER",
  "CROSS","FULL","ON","AND","OR","NOT","AS","GROUP","BY","ORDER","HAVING","LIMIT",
  "OFFSET","INSERT","INTO","VALUES","UPDATE","SET","DELETE","CREATE","TABLE","INDEX",
  "DROP","ALTER","ADD","COLUMN","PRIMARY","KEY","FOREIGN","REFERENCES","UNIQUE",
  "DEFAULT","NULL","CHECK","CONSTRAINT","IS","IN","LIKE","ILIKE","BETWEEN","EXISTS",
  "UNION","ALL","DISTINCT","CASE","WHEN","THEN","ELSE","END","BEGIN","COMMIT",
  "ROLLBACK","TRANSACTION","SAVEPOINT","WITH","RETURNING","IF","DATABASE","SCHEMA",
  "VIEW","TRIGGER","PROCEDURE","FUNCTION","RETURNS","DECLARE","DO","LANGUAGE",
  "PLPGSQL","INTEGER","TEXT","VARCHAR","BOOLEAN","TIMESTAMP","DATE","SERIAL",
  "BIGSERIAL","JSON","JSONB","ARRAY","TRUE","FALSE","ASC","DESC","NULLS","FIRST",
  "LAST","OVER","PARTITION","ROWS","RANGE","UNBOUNDED","PRECEDING","FOLLOWING",
  "CURRENT","ROW","WINDOW","FILTER","EXCLUDE","LATERAL","RECURSIVE","MATERIALIZED",
  "CONCURRENTLY","CASCADE","RESTRICT","NO","ACTION","DEFERRABLE","DEFERRED",
  "IMMEDIATE","TEMP","TEMPORARY","UNLOGGED","LOGGED","EXTENSION","SCHEMA","GRANT",
  "REVOKE","PRIVILEGES","TO","FROM","PUBLIC","ROLE","USER","PASSWORD","OWNED","BY"]);

// --- Rule builders per language family ---

function pyRules() {
  const kwSet = new Set(PY_KW);
  const biSet = new Set(PY_BI);
  return [
    { re: /#[^\n]*/y, cls: "hl-cm" },
    { re: /r?"""[\s\S]*?"""/y, cls: "hl-str" },
    { re: /r?'''[\s\S]*?'''/y, cls: "hl-str" },
    { re: /[fFrRbBuU]{0,2}"(?:[^"\\]|\\.)*"/y, cls: "hl-str" },
    { re: /[fFrRbBuU]{0,2}'(?:[^'\\]|\\.)*'/y, cls: "hl-str" },
    { re: /0[xXbBoO][0-9a-fA-F_]+/y, cls: "hl-num" },
    { re: /\d+(?:\.\d+)?(?:[eEjJ][+-]?\d+)?/y, cls: "hl-num" },
    idRule(kwSet, biSet, true),
    idRule(kwSet, biSet, false),
  ];
}

function sqlRules() {
  return [
    { re: /--[^\n]*/y, cls: "hl-cm" },
    { re: /\/\*[\s\S]*?\*\//y, cls: "hl-cm" },
    { re: /'(?:[^'\\]|\\.)*'/y, cls: "hl-str" },
    { re: /"(?:[^"\\]|\\.)*"/y, cls: "hl-str" },
    { re: /\$\$[\s\S]*?\$\$/y, cls: "hl-str" },
    { re: /\b\d+(?:\.\d+)?\b/y, cls: "hl-num" },
    {
      re: /[a-zA-Z_][a-zA-Z0-9_]*/y,
      fn(m) {
        return SQL_KW.has(m.toUpperCase()) ? sp("hl-kw", m) : esc(m);
      },
    },
  ];
}

function cssRules() {
  return [
    { re: /\/\*[\s\S]*?\*\//y, cls: "hl-cm" },
    { re: /"(?:[^"\\]|\\.)*"/y, cls: "hl-str" },
    { re: /'(?:[^'\\]|\\.)*'/y, cls: "hl-str" },
    // Numbers with optional units
    { re: /-?\d+(?:\.\d+)?(?:px|em|rem|vh|vw|vmin|vmax|%|s|ms|deg|rad|fr|ch|ex|cm|mm|in|pt|pc)?/y, cls: "hl-num" },
    // Color hex values
    { re: /#[0-9a-fA-F]{3,8}\b/y, cls: "hl-num" },
    // At-rules (@media, @keyframes, etc.)
    { re: /@[a-zA-Z-]+/y, cls: "hl-kw" },
    // CSS properties (identifier before colon, not inside selector)
    { re: /[a-zA-Z-]+(?=\s*:)/y, cls: "hl-bi" },
    // CSS keywords
    {
      re: /\b(?:important|inherit|initial|unset|revert|none|auto|normal|bold|italic|solid|dashed|dotted|hidden|visible|flex|grid|block|inline|absolute|relative|fixed|sticky|static|transparent|currentColor|var|calc|min|max|clamp|rgb|rgba|hsl|hsla|linear-gradient|radial-gradient|conic-gradient|url)\b/y,
      cls: "hl-kw",
    },
  ];
}

// Minimal HTML/XML: comments, tags, attribute names, attribute values.
function htmlRules() {
  return [
    { re: /<!--[\s\S]*?-->/y, cls: "hl-cm" },
    { re: /<!\s*DOCTYPE[^>]*>/iy, cls: "hl-cm" },
    { re: /<\/[a-zA-Z][a-zA-Z0-9-:]*>/y, cls: "hl-kw" },
    // Opening tag: consume `<tagname` — attributes handled separately after
    { re: /<[a-zA-Z][a-zA-Z0-9-:.]*/y, cls: "hl-kw" },
    { re: /\/?>|>/y, cls: "hl-kw" },
    { re: /[a-zA-Z_:][a-zA-Z0-9._:-]*(?=\s*=)/y, cls: "hl-bi" },
    { re: /"[^"]*"/y, cls: "hl-str" },
    { re: /'[^']*'/y, cls: "hl-str" },
    { re: /&[a-zA-Z0-9#]+;/y, cls: "hl-num" },
  ];
}

function shRules() {
  const kwSet = new Set(["if","then","else","elif","fi","for","while","do","done",
    "case","esac","function","in","until","select","time","coproc","return",
    "break","continue","exit","local","export","readonly","declare","typeset",
    "unset","shift","set","eval","exec","source","trap","wait","jobs","kill",
    "echo","printf","read","test","true","false","null"]);
  return [
    { re: /#[^\n]*/y, cls: "hl-cm" },
    { re: /"(?:[^"\\$]|\\.|\$\{[^}]*\}|\$[a-zA-Z_][a-zA-Z0-9_]*)*"/y, cls: "hl-str" },
    { re: /'[^']*'/y, cls: "hl-str" },
    { re: /\$\{[^}]*\}/y, cls: "hl-bi" },
    { re: /\$[a-zA-Z_][a-zA-Z0-9_]*/y, cls: "hl-bi" },
    { re: /\$[0-9@#*?$!-]/y, cls: "hl-bi" },
    { re: /\d+/y, cls: "hl-num" },
    { re: /[a-zA-Z_][a-zA-Z0-9_]*(?=[ \t]*\()/y, cls: "hl-fn" },
    {
      re: /[a-zA-Z_][a-zA-Z0-9_-]*/y,
      fn(m) { return kwSet.has(m) ? sp("hl-kw", m) : esc(m); },
    },
  ];
}

function jsonRules() {
  return [
    { re: /"(?:[^"\\]|\\.)*"(?=\s*:)/y, cls: "hl-bi" },  // object keys
    { re: /"(?:[^"\\]|\\.)*"/y, cls: "hl-str" },
    { re: /\b(?:true|false|null)\b/y, cls: "hl-kw" },
    { re: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, cls: "hl-num" },
  ];
}

// --- Rule cache and dispatch ---

const CACHE = new Map();

function buildRules(lang) {
  switch (lang) {
    case "js": case "javascript": case "jsx":
      return clikeRules(JS_KW, JS_BI);
    case "ts": case "typescript": case "tsx":
      return clikeRules(JS_KW, JS_BI);
    case "py": case "python":
      return pyRules();
    case "go":
      return clikeRules(GO_KW, GO_BI);
    case "rs": case "rust":
      return clikeRules(RUST_KW, RUST_BI);
    case "java":
      return clikeRules(JAVA_KW, JAVA_BI);
    case "c": case "cpp": case "c++": case "cc": case "cxx":
      return clikeRules(C_KW, C_BI);
    case "rb": case "ruby":
      return clikeRules(RUBY_KW, RUBY_BI);
    case "json":
      return jsonRules();
    case "css": case "scss": case "less":
      return cssRules();
    case "html": case "xml": case "svg":
      return htmlRules();
    case "sh": case "bash": case "shell": case "zsh": case "fish":
      return shRules();
    case "sql": case "psql": case "pgsql":
      return sqlRules();
    default:
      return null;
  }
}

function getRules(lang) {
  if (CACHE.has(lang)) return CACHE.get(lang);
  const rules = buildRules(lang);
  CACHE.set(lang, rules);
  return rules;
}

export function highlight(code, lang) {
  if (!code) return esc(code || "");
  if (!lang) return esc(code);
  const rules = getRules(lang);
  if (!rules) return esc(code);
  return tokenize(code, rules);
}
