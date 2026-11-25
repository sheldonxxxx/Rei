package dev.rei.android.ui.components.markdown

import androidx.annotation.StringRes
import dev.rei.android.R
import org.commonmark.ext.autolink.AutolinkExtension
import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.ext.task.list.items.TaskListItemsExtension
import org.commonmark.internal.InlineParserImpl
import org.commonmark.node.BlockQuote
import org.commonmark.node.CustomBlock
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Link
import org.commonmark.node.Node
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text
import org.commonmark.parser.InlineParser
import org.commonmark.parser.Parser
import org.commonmark.parser.PostProcessor

/**
 * The Rei dialect (docs/rendering.md) on commonmark: GitHub tables, `~~strikethrough~~`, task items, bare links and
 * GitHub callouts. Footnote citations are taken out of the text before parsing (see [markdownWithCitations]).
 */
internal val markdownParser: Parser = Parser.builder()
    .extensions(
        listOf(
            TablesExtension.create(),
            StrikethroughExtension.builder().requireTwoTildes(true).build(),
            TaskListItemsExtension.create(),
            AutolinkExtension.create(),
        ),
    )
    .inlineParserFactory { context ->
        val delegate = InlineParserImpl(context)
        InlineParser { lines, node ->
            delegate.parse(lines, node)
            val raw = lines.content
            if (('*' in raw || '_' in raw) && !hasEscapedEmphasis(raw)) {
                resolvePunctuationEmphasis(node)
            }
        }
    }
    .postProcessor(CalloutPostProcessor)
    .build()

internal fun parseMarkdown(text: String): Node = markdownParser.parse(text)

internal enum class CalloutKind(@StringRes val labelRes: Int) {
    Note(R.string.markdown_callout_note),
    Tip(R.string.markdown_callout_tip),
    Important(R.string.markdown_callout_important),
    Warning(R.string.markdown_callout_warning),
    Caution(R.string.markdown_callout_caution),
}

/** A foldable callout's starting state: `-` starts closed, `+` starts open. */
internal enum class CalloutFold { Open, Closed }

/**
 * A GitHub callout (`> [!NOTE] Optional title`). Its first child is always the title paragraph (empty when the marker has
 * no text after it, so the kind's name is shown); the rest of its children are the body.
 */
internal class Callout(val kind: CalloutKind, val fold: CalloutFold?) : CustomBlock() {
    val title: Paragraph get() = firstChild as Paragraph
}

// ICU (Android) needs `]` escaped even where the JVM does not.
private val calloutMarker = Regex("^\\[!(note|tip|important|warning|caution)\\]([+-]?)[ \\t]*", RegexOption.IGNORE_CASE)

/** Turns every block quote whose first line is a callout marker into a [Callout], at any depth. */
private object CalloutPostProcessor : PostProcessor {
    override fun process(node: Node): Node {
        val quotes = mutableListOf<BlockQuote>()
        fun collect(at: Node) {
            if (at is BlockQuote) quotes += at
            var child = at.firstChild
            while (child != null) {
                collect(child)
                child = child.next
            }
        }
        collect(node)
        quotes.forEach(::convert)
        return node
    }

    private fun convert(quote: BlockQuote) {
        val first = quote.firstChild as? Paragraph ?: return
        val text = first.firstChild as? Text ?: return
        val match = calloutMarker.find(text.literal) ?: return
        val kind = CalloutKind.entries.first { it.name.equals(match.groupValues[1], ignoreCase = true) }
        val fold = when (match.groupValues[2]) {
            "-" -> CalloutFold.Closed
            "+" -> CalloutFold.Open
            else -> null
        }
        text.literal = text.literal.substring(match.range.last + 1)
        val callout = Callout(kind, fold)
        val title = Paragraph()
        // The title is the rest of the marker line; whatever follows the first line break starts the body.
        var inline = first.firstChild
        while (inline != null && inline !is SoftLineBreak && inline !is HardLineBreak) {
            val next = inline.next
            if (!(inline is Text && inline.literal.isEmpty())) title.appendChild(inline) else inline.unlink()
            inline = next
        }
        (title.lastChild as? Text)?.let { it.literal = it.literal.trimEnd() }
        callout.appendChild(title)
        inline?.let { lineBreak ->
            val rest = lineBreak.next
            lineBreak.unlink()
            if (rest != null) {
                val body = Paragraph()
                var moving: Node? = rest
                while (moving != null) {
                    val next = moving.next
                    body.appendChild(moving)
                    moving = next
                }
                callout.appendChild(body)
            }
        }
        first.unlink()
        var block = quote.firstChild
        while (block != null) {
            val next = block.next
            callout.appendChild(block)
            block = next
        }
        quote.insertAfter(callout)
        quote.unlink()
    }
}

/** True for a closed ```` ```mermaid ```` fence; one still open at the end of the text is a reply that is streaming. */
internal fun isMermaidFence(block: FencedCodeBlock): Boolean =
    block.info.orEmpty().trim().substringBefore(' ').equals("mermaid", ignoreCase = true) && block.closingFenceLength != null

/** A run of task-item text: plain, an agent mention (`@name`) or a due date (`📅 YYYY-MM-DD`). */
internal sealed interface Chip {
    data class Plain(val text: String) : Chip
    data class Mention(val name: String) : Chip
    data class Due(val date: String) : Chip
}

// A mention starts a word, so an email address is not one. Same rule as the web parser's `splitChips`.
private val chipPattern = Regex("(?<![\\p{L}\\p{N}_.@])@[\\p{L}\\p{N}_][\\p{L}\\p{N}_.\\-]*|📅\\s*(\\d{4}-\\d{2}-\\d{2})")

/** Splits the text of a task item into chips; only task items get chips (docs/rendering.md). */
internal fun splitChips(value: String): List<Chip> {
    val out = mutableListOf<Chip>()
    var from = 0
    for (match in chipPattern.findAll(value)) {
        if (match.range.first > from) out += Chip.Plain(value.substring(from, match.range.first))
        out += if (match.value.startsWith("@")) Chip.Mention(match.value.substring(1)) else Chip.Due(match.groupValues[1])
        from = match.range.last + 1
    }
    if (from < value.length) out += Chip.Plain(value.substring(from))
    return out
}

private data class EmphasisMatch(val openIndex: Int, val mark: String, val closeNode: Text, val closeIndex: Int)

private fun hasEscapedEmphasis(raw: String): Boolean {
    if ('\\' !in raw) return false
    var i = 0
    while (i < raw.length) {
        when (raw[i]) {
            '`' -> {
                var ticks = 1
                while (i + ticks < raw.length && raw[i + ticks] == '`') ticks++
                val close = raw.indexOf("`".repeat(ticks), i + ticks)
                i = if (close >= 0) close + ticks else i + ticks
            }
            '\\' -> {
                val next = raw.getOrNull(i + 1)
                if (next == '*' || next == '_') return true
                i += 2
            }
            else -> i++
        }
    }
    return false
}

/**
 * Resolves leftover `***`, `**`, `__`, `*`, and `_` emphasis spans that CommonMark rejected solely due to its
 * punctuation flanking rules (e.g. `**重点：**内容`, `这是**（重点）**`, `**Note:**text`), matching `docs/rendering.md`
 * and the web parser (`apps/web/src/lib/markdown.ts`).
 */
private fun resolvePunctuationEmphasis(container: Node) {
    var child = container.firstChild
    while (child != null) {
        val next = child.next
        if (child is Link || child is Emphasis || child is StrongEmphasis || child is Strikethrough) {
            resolvePunctuationEmphasis(child)
        }
        child = next
    }

    var current = container.firstChild
    while (current != null) {
        if (current !is Text) {
            current = current.next
            continue
        }
        val match = findOpeningDelimiter(current)
        if (match == null) {
            current = current.next
            continue
        }
        val (openIndex, mark, closeNode, closeIndex) = match
        val wrapper: Node = when (mark) {
            "***" -> StrongEmphasis("***").also { strong ->
                val inner = Emphasis("*")
                strong.appendChild(inner)
                moveRangeInto(current, openIndex, mark.length, closeNode, closeIndex, insertTarget = strong, contentParent = inner)
                resolvePunctuationEmphasis(inner)
            }
            "**", "__" -> StrongEmphasis(mark).also { strong ->
                moveRangeInto(current, openIndex, mark.length, closeNode, closeIndex, insertTarget = strong, contentParent = strong)
                resolvePunctuationEmphasis(strong)
            }
            else -> Emphasis(mark).also { em ->
                moveRangeInto(current, openIndex, mark.length, closeNode, closeIndex, insertTarget = em, contentParent = em)
                resolvePunctuationEmphasis(em)
            }
        }
        current = wrapper.next
    }
}

private fun findOpeningDelimiter(node: Text): EmphasisMatch? {
    val literal = node.literal
    for (i in literal.indices) {
        val ch = literal[i]
        val marks = when (ch) {
            '*' -> listOf("***", "**", "*")
            '_' -> listOf("__", "_")
            else -> continue
        }
        for (mark in marks) {
            if (!literal.startsWith(mark, i)) continue
            val from = i + mark.length
            if (!hasNonWhitespaceAfter(node, literal, from)) continue
            if (ch == '_' && isWordBefore(node, literal, i)) continue
            val close = findClosingDelimiter(node, from, mark) ?: continue
            return EmphasisMatch(i, mark, close.first, close.second)
        }
    }
    return null
}

private fun findClosingDelimiter(startNode: Text, startFrom: Int, mark: String): Pair<Text, Int>? {
    val ch = mark[0]
    var scan: Node? = startNode
    var first = true
    while (scan != null) {
        if (scan is Text) {
            val s = scan.literal
            // At least one non-empty character or node must sit between opener and closer.
            var at = if (first) startFrom + 1 else 0
            while (at <= s.length - mark.length) {
                val found = s.indexOf(mark, at)
                if (found < 0) break
                if (mark.length == 1 && found + 1 < s.length && s[found + 1] == ch) {
                    at = found + 2
                    continue
                }
                if (hasNonWhitespaceBefore(scan, s, found) && (ch != '_' || !isWordAfter(scan, s, found + mark.length))) {
                    return scan to found
                }
                at = found + 1
            }
        }
        first = false
        scan = scan.next
    }
    return null
}

private fun hasNonWhitespaceAfter(node: Text, literal: String, index: Int): Boolean {
    if (index < literal.length) return !literal[index].isWhitespace()
    val next = node.next ?: return false
    if (next is SoftLineBreak || next is HardLineBreak) return false
    if (next is Text) return next.literal.firstOrNull()?.let { !it.isWhitespace() } ?: false
    return true
}

private fun hasNonWhitespaceBefore(node: Text, literal: String, index: Int): Boolean {
    if (index > 0) return !literal[index - 1].isWhitespace()
    val prev = node.previous ?: return false
    if (prev is SoftLineBreak || prev is HardLineBreak) return false
    if (prev is Text) return prev.literal.lastOrNull()?.let { !it.isWhitespace() } ?: false
    return true
}

private fun isWordBefore(node: Text, literal: String, index: Int): Boolean {
    if (index > 0) return literal[index - 1].isLetterOrDigit()
    val prev = node.previous
    return prev is Text && prev.literal.lastOrNull()?.isLetterOrDigit() == true
}

private fun isWordAfter(node: Text, literal: String, index: Int): Boolean {
    if (index < literal.length) return literal[index].isLetterOrDigit()
    val next = node.next
    return next is Text && next.literal.firstOrNull()?.isLetterOrDigit() == true
}

private fun moveRangeInto(
    openNode: Text,
    openIndex: Int,
    markLen: Int,
    closeNode: Text,
    closeIndex: Int,
    insertTarget: Node,
    contentParent: Node,
) {
    if (openNode === closeNode) {
        val s = openNode.literal
        val before = s.substring(0, openIndex)
        val inner = s.substring(openIndex + markLen, closeIndex)
        val after = s.substring(closeIndex + markLen)
        if (before.isNotEmpty()) openNode.insertBefore(Text(before))
        openNode.insertBefore(insertTarget)
        if (inner.isNotEmpty()) contentParent.appendChild(Text(inner))
        if (after.isNotEmpty()) openNode.insertBefore(Text(after))
        openNode.unlink()
        return
    }
    val openLiteral = openNode.literal
    val before = openLiteral.substring(0, openIndex)
    val innerStart = openLiteral.substring(openIndex + markLen)
    val closeLiteral = closeNode.literal
    val innerEnd = closeLiteral.substring(0, closeIndex)
    val after = closeLiteral.substring(closeIndex + markLen)

    if (before.isNotEmpty()) openNode.insertBefore(Text(before))
    openNode.insertBefore(insertTarget)
    if (innerStart.isNotEmpty()) contentParent.appendChild(Text(innerStart))
    var moving = openNode.next
    while (moving != null && moving !== closeNode) {
        val next = moving.next
        contentParent.appendChild(moving)
        moving = next
    }
    if (innerEnd.isNotEmpty()) contentParent.appendChild(Text(innerEnd))
    if (after.isNotEmpty()) closeNode.insertAfter(Text(after))
    openNode.unlink()
    closeNode.unlink()
}
