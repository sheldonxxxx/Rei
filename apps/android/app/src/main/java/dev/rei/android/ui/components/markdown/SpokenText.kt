package dev.rei.android.ui.components.markdown

private val Fence = Regex("""^\s*(```|~~~)\s*[\w+-]*\s*$""")
private val TableRule = Regex("""^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$""")
private val Heading = Regex("""^\s{0,3}#{1,6}\s+""")
private val Quote = Regex("""^\s*>\s?""")
private val Bullet = Regex("""^\s*([-*+]|\d+[.)])\s+""")
private val Image = Regex("""!\[([^\]]*)]\([^)]*\)""")
private val Link = Regex("""\[([^\]]+)]\([^)]*\)""")
private val FootnoteDefinition = Regex("""^\s*\[\^[^\]]+]:\s*""")
private val Footnote = Regex("""\[\^[^\]]+]""")
private val Emphasis = Regex("""(\*\*|__|~~|\*|`)""")

/**
 * The words of a markdown reply without its markup, for a screen reader: no fence lines, table rules, pipes, heading marks,
 * link targets or emphasis characters. Code lines and table cells keep their text, one per line.
 */
fun spokenText(markdown: String): String =
    markdown.lineSequence()
        .filterNot { Fence.matches(it) || TableRule.matches(it) }
        .map { line ->
            var out = line.replace(FootnoteDefinition, "").replace(Heading, "").replace(Quote, "").replace(Bullet, "")
            out = out.replace(Image) { it.groupValues[1] }.replace(Link) { it.groupValues[1] }.replace(Footnote, "")
            if (out.trimStart().startsWith("|")) out = out.trim().trim('|').split('|').joinToString(", ") { it.trim() }
            out.replace(Emphasis, "").trim()
        }
        .filter { it.isNotEmpty() }
        .joinToString("\n")
