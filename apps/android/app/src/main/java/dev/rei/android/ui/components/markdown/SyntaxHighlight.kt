package dev.rei.android.ui.components.markdown

enum class TokenKind { Plain, Keyword, Str, Number, Comment }

data class CodeToken(val text: String, val kind: TokenKind)

private val keywords = setOf(
    "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "default", "del",
    "do", "else", "elif", "enum", "except", "export", "extends", "false", "final", "finally", "fn", "for", "from", "fun",
    "func", "function", "if", "implements", "import", "in", "interface", "is", "lambda", "let", "match", "new", "none",
    "None", "not", "null", "nil", "of", "or", "and", "override", "package", "pass", "private", "protected", "public",
    "raise", "return", "self", "static", "struct", "super", "switch", "this", "throw", "true", "True", "False", "try",
    "type", "typeof", "val", "var", "void", "when", "where", "while", "with", "yield",
    // SQL and shell, matched case-insensitively below.
    "select", "insert", "update", "delete", "create", "table", "join", "group", "order", "by", "limit", "values", "set",
    "then", "fi", "done", "echo",
)

private val caseInsensitive = setOf("select", "insert", "update", "delete", "create", "table", "join", "group", "order", "by", "limit", "values", "set")

private val hashComments = setOf("python", "py", "sh", "bash", "zsh", "shell", "yaml", "yml", "ruby", "rb", "toml", "dockerfile", "r", "perl")
private val dashComments = setOf("sql", "lua", "haskell")
private val noSlashComments = hashComments + dashComments + setOf("json", "jsonc", "html", "xml", "markdown", "md", "text", "txt")

/**
 * A small, dependency-free highlighter: comments, strings, numbers and keywords. It is deliberately language-agnostic (a
 * shared keyword list), because a code block is something to read and copy, not to compile. Never throws; unknown languages
 * still get strings, numbers and comments.
 */
fun tokenizeCode(code: String, language: String = ""): List<CodeToken> {
    val lang = language.trim().lowercase().substringBefore(' ')
    val comment = buildString {
        if (lang !in noSlashComments) append("//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|\\z)|")
        if (lang in hashComments) append("#[^\\n]*|")
        if (lang in dashComments) append("--[^\\n]*|")
    }.removeSuffix("|")
    val pattern = Regex(
        (if (comment.isNotEmpty()) "(?<c>$comment)|" else "") +
            "(?<s>\"\"\"[\\s\\S]*?(?:\"\"\"|\\z)|\"(?:\\\\.|[^\"\\\\\\n])*\"?|'(?:\\\\.|[^'\\\\\\n])*'?|`(?:\\\\.|[^`\\\\])*`?)|" +
            "(?<n>\\b\\d+(?:\\.\\d+)?\\b)|" +
            "(?<w>\\b[A-Za-z_][A-Za-z0-9_]*\\b)",
    )
    val tokens = mutableListOf<CodeToken>()
    var cursor = 0
    fun plain(until: Int) {
        if (until > cursor) tokens += CodeToken(code.substring(cursor, until), TokenKind.Plain)
    }
    for (match in pattern.findAll(code)) {
        val groups = match.groups
        val kind = when {
            comment.isNotEmpty() && groups["c"] != null -> TokenKind.Comment
            groups["s"] != null -> TokenKind.Str
            groups["n"] != null -> TokenKind.Number
            else -> {
                val text = match.value
                if (text in keywords || (text.lowercase() in caseInsensitive && lang == "sql")) TokenKind.Keyword else continue
            }
        }
        plain(match.range.first)
        tokens += CodeToken(match.value, kind)
        cursor = match.range.last + 1
    }
    plain(code.length)
    return tokens
}
