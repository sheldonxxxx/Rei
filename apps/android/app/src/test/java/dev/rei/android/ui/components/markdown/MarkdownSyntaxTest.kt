package dev.rei.android.ui.components.markdown

import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.task.list.items.TaskListItemMarker
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Code
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.Node
import org.commonmark.node.Paragraph
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownSyntaxTest {
    private fun kids(node: Node): List<Node> = generateSequence(node.firstChild) { it.next }.toList()

    private fun all(node: Node): List<Node> = kids(node).flatMap { listOf(it) + all(it) }

    private fun plain(node: Node): String = kids(node).joinToString("") {
        when (it) {
            is Text -> it.literal
            is Code -> it.literal
            else -> plain(it)
        }
    }

    private fun callout(text: String): Callout = parseMarkdown(text).firstChild as Callout

    @Test
    fun everyCalloutKindIsRecognisedInAnyCase() {
        val kinds = mapOf(
            "[!NOTE]" to CalloutKind.Note,
            "[!tip]" to CalloutKind.Tip,
            "[!Important]" to CalloutKind.Important,
            "[!WARNING]" to CalloutKind.Warning,
            "[!caution]" to CalloutKind.Caution,
        )
        kinds.forEach { (marker, kind) ->
            val parsed = callout("> $marker\n> Body text.")
            assertEquals(kind, parsed.kind)
            assertNull(parsed.fold)
            assertNull("no custom title", parsed.title.firstChild)
            assertEquals("Body text.", plain(parsed.title.next!!))
        }
    }

    @Test
    fun foldSignsSetTheStartingState() {
        assertEquals(CalloutFold.Closed, callout("> [!NOTE]-\n> Hidden at first.").fold)
        assertEquals(CalloutFold.Open, callout("> [!TIP]+ Shown at first\n> Body.").fold)
    }

    @Test
    fun textAfterTheMarkerIsTheTitleWithItsFormatting() {
        val parsed = callout("> [!WARNING] Back up **first**\n> Then upgrade.\n>\n> - one step")
        assertEquals("Back up first", plain(parsed.title))
        assertTrue(kids(parsed.title).any { it is StrongEmphasis })
        val body = kids(parsed).drop(1)
        assertEquals("Then upgrade.", plain(body[0]))
        assertTrue(body[1] is BulletList)
    }

    @Test
    fun aMarkerAloneWithABlankQuotedLineStillHasItsBody() {
        val parsed = callout("> [!IMPORTANT]\n>\n> Separate paragraph.")
        assertNull(parsed.title.firstChild)
        assertEquals(listOf("Separate paragraph."), kids(parsed).drop(1).map(::plain))
    }

    @Test
    fun aQuoteThatIsNotACalloutStaysAQuote() {
        listOf("> Just a quote.", "> [!UNKNOWN] Not a kind", "> Text then [!NOTE] later").forEach { input ->
            val first = parseMarkdown(input).firstChild
            assertTrue(input, first is BlockQuote)
        }
        assertTrue("a marker only counts in a quote", parseMarkdown("[!NOTE] plain").firstChild is Paragraph)
    }

    @Test
    fun calloutsInsideListsAreFoundToo() {
        val root = parseMarkdown("- item\n\n  > [!TIP]\n  > Nested.")
        assertTrue(all(root).any { it is Callout })
    }

    @Test
    fun taskItemsCarryTheirMarkerAndKeepTheirText() {
        val root = parseMarkdown("- [ ] Draft @writer 📅 2026-01-05\n- [x] Shipped\n- plain item")
        val items = kids(root.firstChild!!)
        val first = items[0].firstChild as TaskListItemMarker
        assertFalse(first.isChecked)
        assertEquals("Draft @writer 📅 2026-01-05", plain(first.next!!))
        assertTrue((items[1].firstChild as TaskListItemMarker).isChecked)
        assertFalse(items[2].firstChild is TaskListItemMarker)
    }

    @Test
    fun chipsSplitMentionsAndDatesButNotEmailAddresses() {
        assertEquals(
            listOf(Chip.Plain("Draft "), Chip.Mention("writer"), Chip.Plain(" by "), Chip.Due("2026-01-05")),
            splitChips("Draft @writer by 📅 2026-01-05"),
        )
        assertEquals(listOf(Chip.Plain("mail me@example.com")), splitChips("mail me@example.com"))
        assertEquals(listOf(Chip.Due("2026-02-01")), splitChips("📅2026-02-01"))
    }

    @Test
    fun doubleTildesStrikeAndSingleOnesDoNot() {
        val root = parseMarkdown("~~gone~~ and ~kept~")
        val struck = all(root).filterIsInstance<Strikethrough>()
        assertEquals(1, struck.size)
        assertEquals("gone", plain(struck[0]))
        assertTrue(plain(root).contains("~kept~"))
    }

    @Test
    fun bareUrlsBecomeLinksWithoutTrailingPunctuation() {
        val links = all(parseMarkdown("See https://example.com/docs. Or `https://not.linked` in code.")).filterIsInstance<Link>()
        assertEquals(listOf("https://example.com/docs"), links.map { it.destination })
        assertTrue(isExternalMarkdownLink(links[0].destination))
    }

    @Test
    fun tableCellsKeepTheirColumnAlignment() {
        val table = parseMarkdown("| L | C | R | N |\n| :--- | :---: | ---: | --- |\n| a | b | c | d |").firstChild as TableBlock
        val cells = all(table).filterIsInstance<TableCell>().take(4)
        assertEquals(
            listOf(TableCell.Alignment.LEFT, TableCell.Alignment.CENTER, TableCell.Alignment.RIGHT, null),
            cells.map { it.alignment },
        )
    }

    @Test
    fun onlyAClosedMermaidFenceIsADiagram() {
        val closed = parseMarkdown("```mermaid\ngraph TD; A-->B\n```").firstChild as FencedCodeBlock
        val open = parseMarkdown("```mermaid\ngraph TD; A-->B").firstChild as FencedCodeBlock
        val other = parseMarkdown("```kotlin\nval x = 1\n```").firstChild as FencedCodeBlock
        assertTrue(isMermaidFence(closed))
        assertFalse(isMermaidFence(open))
        assertFalse(isMermaidFence(other))
    }

    @Test
    fun citationsStillWorkWithTheExtensions() {
        val parsed = markdownWithCitations("> [!NOTE]\n> Claim[^a] at https://example.com\n\n[^a]: ~~old~~ source")
        assertEquals(listOf("a"), parsed.citations.keys.toList())
        assertTrue(parseMarkdown(parsed.body).firstChild is Callout)
    }

    @Test
    fun strongEmphasisRendersBesideCjkAndPunctuation() {
        val cases = listOf(
            "**重点：**内容" to listOf("重点："),
            "这是**（重点）**内容" to listOf("（重点）"),
            "**Note:**text" to listOf("Note:"),
            "**100%**done" to listOf("100%"),
            "**第一个：**A 和 **第二个：**B" to listOf("第一个：", "第二个："),
            "**重点 `code`：**内容" to listOf("重点 code："),
            "`\\*` and **重点：**内容" to listOf("重点："),
        )
        cases.forEach { (input, expectedBold) ->
            val root = parseMarkdown(input)
            val bolds = all(root).filterIsInstance<StrongEmphasis>().map(::plain)
            assertEquals(input, expectedBold, bolds)
            assertFalse("$input should not leak **", plain(root).contains("**"))
        }
    }

    @Test
    fun escapedOrSpacedAsterisksAndSnakeCaseStayPlainText() {
        listOf(
            "\\*not em\\*",
            "\\*\\*not bold\\*\\*",
            "** not bold **",
            "snake_case_name",
        ).forEach { input ->
            val root = parseMarkdown(input)
            assertTrue(input, all(root).filterIsInstance<StrongEmphasis>().isEmpty())
        }
    }

    @Test
    fun calloutTitleAndLinksAlsoSupportPunctuationBold() {
        val parsed = callout("> [!NOTE] **注意：**内容\n> Body")
        assertEquals(listOf("注意："), all(parsed.title).filterIsInstance<StrongEmphasis>().map(::plain))

        val linked = parseMarkdown("[**重要：**查看](https://example.com)")
        val link = all(linked).filterIsInstance<Link>().single()
        assertEquals(listOf("重要："), all(link).filterIsInstance<StrongEmphasis>().map(::plain))
    }
}
