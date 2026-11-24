package dev.rei.android.ui.components.markdown

import androidx.annotation.StringRes
import dev.rei.android.R
import org.commonmark.ext.autolink.AutolinkExtension
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.ext.task.list.items.TaskListItemsExtension
import org.commonmark.node.BlockQuote
import org.commonmark.node.CustomBlock
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Node
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.Text
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
