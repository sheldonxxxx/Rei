package dev.rei.android.ui.components.markdown

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.RowScope
import androidx.compose.material3.Checkbox
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.em
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import dev.rei.android.data.ReiApi
import dev.rei.android.data.optionalString
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.LocalWorkspaceOpener
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.copyToClipboard
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.LocalMotionScale
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okio.Buffer
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TableHead
import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.ext.task.list.items.TaskListItemMarker
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Code
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image as MarkdownImage
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text as MarkdownText
import org.commonmark.node.ThematicBreak
import java.time.LocalDate

private val citationDefinition = Regex("^ {0,3}\\[\\^([^]\\s]+)]\\s*:\\s*(.*)$")
private val citationUse = Regex("\\[\\^([^]\\s]+)]")
private val fence = Regex("^ {0,3}(`{3,}|~{3,}).*$")
private val fileLink = Regex("^file:([A-Za-z0-9_-]+)(?:@([A-Za-z0-9_-]+))?$")
private val pageLink = Regex("^page:([A-Za-z0-9_-]+)(?:#(.*))?$")
private val imageHttp = OkHttpClient.Builder().followRedirects(false).build()

/** A picture the reader can open full screen. */
data class PictureSource(val destination: String, val caption: String)

/** Set by the chat so tapping a picture in a message opens the full-screen viewer; null elsewhere (pictures stay inline). */
val LocalPictureOpener = staticCompositionLocalOf<((PictureSource) -> Unit)?> { null }

internal data class MarkdownWithCitations(val body: String, val citations: Map<String, String>)

internal fun markdownWithCitations(text: String): MarkdownWithCitations {
    val lines = text.lines()
    val content = mutableListOf<String>()
    val definitions = linkedMapOf<String, String>()
    var index = 0
    var delimiter: String? = null
    while (index < lines.size) {
        val line = lines[index++]
        val marker = fence.matchEntire(line)?.groupValues?.get(1)
        if (marker != null) {
            val opened = delimiter
            delimiter = if (opened == null) marker else if (marker.startsWith(opened)) null else opened
            content += line
            continue
        }
        val definition = if (delimiter == null) citationDefinition.matchEntire(line) else null
        if (definition == null) {
            content += line
            continue
        }
        val (_, label, first) = definition.groupValues
        val note = mutableListOf(first)
        while (index < lines.size) {
            val continuation = lines[index]
            if (!continuation.startsWith("    ") && !continuation.startsWith("\t")) break
            note += continuation.removePrefix("    ").removePrefix("\t")
            index++
        }
        definitions.putIfAbsent(label, note.joinToString("\n"))
    }
    val ids = linkedMapOf<String, Int>()
    fun rewrite(node: Node) {
        if (node is MarkdownText) {
            citationUse.findAll(node.literal).forEach { match ->
                val label = match.groupValues[1]
                if (label in definitions) ids.getOrPut(label) { ids.size + 1 }
            }
        }
        children(node).forEach(::rewrite)
    }
    val body = content.joinToString("\n")
    rewrite(parseMarkdown(body))
    definitions.keys.forEach { ids.getOrPut(it) { ids.size + 1 } }
    return MarkdownWithCitations(body, ids.keys.associateWith { definitions.getValue(it) })
}

internal fun isExternalMarkdownLink(url: String): Boolean {
    val parsed = url.toHttpUrlOrNull()
    if (parsed != null) return parsed.username.isEmpty() && parsed.password.isEmpty()
    return url.startsWith("mailto:", ignoreCase = true) && '\r' !in url && '\n' !in url
}

/** `file:<id>[@<version>]` and `page:<id>[#fragment]`, the two references an agent can make into the Library and Knowledge. */
internal sealed interface Reference {
    data class File(val id: String, val version: String) : Reference
    data class Page(val id: String, val fragment: String) : Reference
}

internal fun parseReference(url: String): Reference? {
    fileLink.matchEntire(url)?.let { return Reference.File(it.groupValues[1], it.groupValues[2]) }
    pageLink.matchEntire(url)?.let { return Reference.Page(it.groupValues[1], it.groupValues[2]) }
    return null
}

/**
 * Renders an agent's Markdown: headings, lists, quotes, tables and code blocks that scroll on their own, inline code,
 * links, file and page references as chips and citations. [caret] adds the streaming caret after the last text block.
 * Text is not selectable here: a long press belongs to the message sheet, whose "Select text" opens the whole message.
 */
@Composable
fun ReiMarkdown(text: String, api: ReiApi, modifier: Modifier = Modifier, caret: Boolean = false) {
    val context = LocalContext.current
    val opener = LocalWorkspaceOpener.current
    val document = remember(text) { markdownWithCitations(text) }
    val root = remember(document.body) { parseMarkdown(document.body) }
    var note by remember(text) { mutableStateOf<String?>(null) }
    val citationNumbers = remember(document) { document.citations.keys.withIndex().associate { (i, label) -> label to i + 1 } }
    fun open(url: String) {
        when (val target = linkTarget(url)) {
            is LinkTarget.Page -> opener?.openPage(target.id)
            is LinkTarget.File -> opener?.openFile(target.id, target.versionId)
            is LinkTarget.External -> openExternalLink(context, target.url)
            LinkTarget.Ignored -> Unit
        }
    }
    val env = MarkdownEnv(api, citationNumbers, ::open, { note = it }, if (caret) lastTextBlock(root) else null, streaming = caret)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        MarkdownBlocks(root, env)
        val unused = document.citations.keys.filter { label -> !document.body.contains("[^$label]") }
        if (unused.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                unused.forEach { label ->
                    ReferenceChip(ReiIcons.Book, "Source ${citationNumbers[label]}", onClick = { note = label })
                }
            }
        }
    }
    note?.let { label ->
        val noteBody = document.citations[label].orEmpty()
        val noteRoot = remember(noteBody) { parseMarkdown(noteBody) }
        ReiSheet(onDismiss = { note = null }, title = "Source ${citationNumbers[label]}") {
            Column(Modifier.padding(horizontal = 24.dp, vertical = 8.dp)) {
                MarkdownBlocks(noteRoot, MarkdownEnv(api, emptyMap(), ::open, {}, null))
            }
        }
    }
}

private data class MarkdownEnv(
    val api: ReiApi,
    val citations: Map<String, Int>,
    val open: (String) -> Unit,
    val cite: (String) -> Unit,
    val caretBlock: Node?,
    /** The reply is still arriving: a Mermaid fence stays code until it is complete. */
    val streaming: Boolean = false,
    /** Inside a task item, where `@name` and `📅 date` become chips. */
    val chips: Boolean = false,
    /** The first paragraph of a ticked task, drawn struck through and muted. */
    val struck: Node? = null,
)

/** Where a tapped link goes: a Knowledge page or Library file in the app, an outside address in a Custom Tab, or nowhere. */
internal sealed interface LinkTarget {
    data class Page(val id: String) : LinkTarget
    data class File(val id: String, val versionId: String?) : LinkTarget
    data class External(val url: String) : LinkTarget
    data object Ignored : LinkTarget
}

internal fun linkTarget(url: String): LinkTarget = when (val reference = parseReference(url)) {
    is Reference.Page -> LinkTarget.Page(reference.id)
    is Reference.File -> LinkTarget.File(reference.id, reference.version.ifEmpty { null })
    null -> if (isExternalMarkdownLink(url)) LinkTarget.External(url) else LinkTarget.Ignored
}

/** Opens an outside address (https or mailto) in a Custom Tab; says so when nothing can open it. */
internal fun openExternalLink(context: android.content.Context, address: String) {
    try {
        androidx.browser.customtabs.CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, address.toUri())
    } catch (_: android.content.ActivityNotFoundException) {
        android.widget.Toast.makeText(context, "No app can open this link.", android.widget.Toast.LENGTH_SHORT).show()
    }
}

@Composable
private fun MarkdownBlocks(parent: Node, env: MarkdownEnv, skip: Node? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (node in children(parent)) if (node !== skip) when (node) {
            is Paragraph -> {
                val references = referenceOnly(node)
                if (references != null) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        references.forEach { (label, url) ->
                            val kind = parseReference(url)
                            ReferenceChip(if (kind is Reference.Page) ReiIcons.Page else ReiIcons.File, label, onClick = { env.open(url) })
                        }
                    }
                } else {
                    InlineMarkdown(node, env)
                }
                children(node).filterIsInstance<MarkdownImage>().filter { fileLink.matches(it.destination) }.forEach { image ->
                    MarkdownPicture(env.api, image.destination, inlinePlain(image))
                }
            }
            is Heading -> InlineMarkdown(node, env, heading = node.level)
            is BulletList, is OrderedList -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                children(node).forEachIndexed { index, item ->
                    val task = item.firstChild as? TaskListItemMarker
                    if (task != null) {
                        TaskItem(item, task, env)
                    } else Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        val marker = if (node is OrderedList) "${node.markerStartNumber + index}." else "•"
                        Text(marker, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
                        Box(Modifier.weight(1f)) { MarkdownBlocks(item, env) }
                    }
                }
            }
            is BlockQuote -> Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.width(3.dp).fillMaxHeight().background(MaterialTheme.colorScheme.outlineVariant, ReiShapes.Pill))
                Box(Modifier.weight(1f)) { MarkdownBlocks(node, env) }
            }
            is Callout -> CalloutBlock(node, env)
            is FencedCodeBlock -> if (isMermaidFence(node) && !env.streaming) MermaidBlock(node.literal) else CodeBlock(node.info, node.literal)
            is IndentedCodeBlock -> CodeBlock("", node.literal)
            is ThematicBreak -> HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            is HtmlBlock -> Text(node.literal, style = MaterialTheme.typography.bodyLarge)
            is TableBlock -> MarkdownTable(node, env)
        }
    }
}

/** A task item: a read-only checkbox, then the item's blocks with agent and date chips. */
@Composable
private fun TaskItem(item: Node, task: TaskListItemMarker, env: MarkdownEnv) {
    val label = (task.next as? Paragraph)?.let(::inlinePlain)?.trim()?.take(120).orEmpty()
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        // A 24dp box, the height of the first line of body text.
        Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
            Checkbox(
                checked = task.isChecked,
                onCheckedChange = null,
                modifier = Modifier.semantics {
                    contentDescription = if (label.isEmpty()) "Task" else "Task: $label"
                    toggleableState = ToggleableState(task.isChecked)
                    role = Role.Checkbox
                },
            )
        }
        Box(Modifier.weight(1f)) {
            MarkdownBlocks(item, env.copy(chips = true, struck = if (task.isChecked) task.next as? Paragraph else null))
        }
    }
}

private val Callout.color: Color
    @Composable get() = when (kind) {
        CalloutKind.Note, CalloutKind.Important -> MaterialTheme.colorScheme.primary
        CalloutKind.Tip -> ReiTheme.colors.supportingTextStrong
        CalloutKind.Warning -> MaterialTheme.colorScheme.onTertiaryContainer
        CalloutKind.Caution -> MaterialTheme.colorScheme.error
    }

/** A GitHub callout: a tinted box with the kind's icon and label (or its own title) above the body; `-`/`+` fold it. */
@Composable
private fun CalloutBlock(callout: Callout, env: MarkdownEnv) {
    val colors = MaterialTheme.colorScheme
    val tint = callout.color
    val icon = when (callout.kind) {
        CalloutKind.Note -> ReiIcons.Info
        CalloutKind.Tip -> ReiIcons.Sparkle
        else -> ReiIcons.Alert
    }
    val foldable = callout.fold != null
    // Keyed by position, not by the node: a streaming reply is parsed again on every update.
    var open by remember { mutableStateOf(callout.fold != CalloutFold.Closed) }
    val hasBody = callout.title.next != null
    Column(
        Modifier
            .fillMaxWidth()
            .clip(ReiShapes.Inset)
            .border(BorderStroke(1.dp, tint.copy(alpha = 0.45f).compositeOver(colors.outlineVariant)), ReiShapes.Inset)
            .background(tint.copy(alpha = 0.07f).compositeOver(colors.surfaceContainerLowest)),
    ) {
        val header = if (foldable) {
            Modifier
                .clickable(onClickLabel = if (open) "Collapse" else "Expand", role = Role.Button) { open = !open }
                .semantics {
                    stateDescription = if (open) "Expanded" else "Collapsed"
                    if (open) collapse { open = false; true } else expand { open = true; true }
                }
                .heightIn(min = 48.dp)
        } else Modifier
        Row(
            header.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(icon, contentDescription = null, Modifier.size(16.dp), tint = tint)
            Box(Modifier.weight(1f)) {
                if (callout.title.firstChild != null) InlineMarkdown(callout.title, env, bold = true, compact = true)
                else Text(callout.kind.label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            }
            if (foldable) Icon(
                ReiIcons.Chevron,
                contentDescription = null,
                Modifier.size(18.dp).rotate(if (open) 180f else 0f),
                tint = colors.onSurfaceVariant,
            )
        }
        if (hasBody && open) Box(Modifier.padding(start = 14.dp, end = 14.dp, bottom = 12.dp)) {
            MarkdownBlocks(callout, env, skip = callout.title)
        }
    }
}

/** A paragraph that is only references (file and page links, separated by spaces or commas) shows them as chips. */
private fun referenceOnly(paragraph: Paragraph): List<Pair<String, String>>? {
    val parts = children(paragraph).toList()
    val links = parts.filterIsInstance<Link>()
    if (links.isEmpty() || links.any { parseReference(it.destination) == null }) return null
    val others = parts.filterNot { it is Link }
    if (!others.all { (it is MarkdownText && it.literal.all { c -> c.isWhitespace() || c == ',' || c == ';' }) || it is SoftLineBreak }) return null
    return links.map { inlinePlain(it).ifBlank { it.destination } to it.destination }
}

private fun lastTextBlock(root: Node): Node? {
    var result: Node? = null
    fun visit(node: Node) {
        when (node) {
            is Paragraph, is Heading -> result = node
            is FencedCodeBlock, is IndentedCodeBlock, is TableBlock -> result = null
            else -> children(node).forEach(::visit)
        }
    }
    visit(root)
    return result
}

@Composable
internal fun ReferenceChip(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        onClick = onClick,
        modifier = modifier.semantics { role = Role.Button },
        shape = ReiShapes.Pill,
        color = MaterialTheme.colorScheme.surfaceContainerLowest,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(
            Modifier.padding(start = 10.dp, end = 12.dp, top = 6.dp, bottom = 6.dp).heightIn(min = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(icon, contentDescription = null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(label, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 220.dp))
        }
    }
}

/** A code block's frame: a bordered inset with a label and actions in its header row. */
@Composable
internal fun CodeFrame(label: String, actions: @Composable RowScope.() -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val colors = MaterialTheme.colorScheme
    Column(
        Modifier
            .fillMaxWidth()
            .border(BorderStroke(1.dp, colors.outlineVariant), ReiShapes.Inset)
            .background(colors.surfaceContainerLowest, ReiShapes.Inset),
    ) {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
            actions()
        }
        content()
    }
}

/** Monospace code that scrolls sideways on its own. */
@Composable
internal fun CodeText(text: AnnotatedString) {
    Text(
        text,
        Modifier.horizontalScroll(rememberScrollState()).padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
        fontFamily = FontFamily.Monospace,
        fontSize = 13.sp,
        lineHeight = 20.sp,
        color = MaterialTheme.colorScheme.onSurface,
        softWrap = false,
    )
}

/** A fenced or indented code block, coloured when its language is known; [note] says why it is shown as code. */
@Composable
internal fun CodeBlock(language: String, code: String, note: String? = null) {
    val context = LocalContext.current
    val colors = MaterialTheme.colorScheme
    val syntax = ReiTheme.colors
    val lang = language.trim().substringBefore(' ')
    val text = remember(code, lang, colors, syntax) {
        val body = code.trimEnd()
        buildAnnotatedString {
            for (token in tokenizeCode(body, lang)) {
                val color = when (token.kind) {
                    TokenKind.Plain -> null
                    TokenKind.Keyword -> syntax.syntaxKeyword
                    TokenKind.Str -> syntax.syntaxString
                    TokenKind.Number -> syntax.syntaxNumber
                    TokenKind.Comment -> colors.onSurfaceVariant
                }
                if (color == null) append(token.text)
                else withStyle(SpanStyle(color = color, fontStyle = if (token.kind == TokenKind.Comment) FontStyle.Italic else null)) { append(token.text) }
            }
        }
    }
    CodeFrame(lang.ifBlank { "Code" }, actions = {
        ReiIconButton(ReiIcons.Copy, "Copy code", { copyToClipboard(context, "Rei code", code.trimEnd()) })
    }) {
        if (note != null) Text(
            note,
            Modifier.padding(start = 12.dp, end = 12.dp, bottom = 8.dp).semantics { liveRegion = LiveRegionMode.Polite },
            style = MaterialTheme.typography.bodySmall,
            color = colors.onSurfaceVariant,
        )
        CodeText(text)
    }
}

@Composable
private fun MarkdownTable(table: TableBlock, env: MarkdownEnv) {
    val colors = MaterialTheme.colorScheme
    val rows = children(table).flatMap { section -> children(section).map { row -> (section is TableHead) to children(row).toList() } }.toList()
    // Column widths are estimated from the text length, so they grow with the font size (200% must not break words).
    val fontScale = LocalDensity.current.fontScale
    val widths = remember(table, fontScale) {
        val columns = rows.maxOfOrNull { it.second.size } ?: 0
        (0 until columns).map { column ->
            val longest = rows.maxOf { (_, cells) -> cells.getOrNull(column)?.let(::inlinePlain)?.length ?: 0 }
            ((longest * 8 + 24) * fontScale).coerceIn(80f * fontScale, 260f * fontScale).dp
        }
    }
    // The card colour is the table body; the header needs a visible tonal step from it in both schemes.
    val headerFill = if (colors.surface.luminance() < 0.5f) colors.surfaceContainerHighest else colors.surfaceContainer
    BoxWithConstraints(
        Modifier
            .fillMaxWidth()
            .border(BorderStroke(1.dp, colors.outlineVariant), ReiShapes.Inset)
            .background(colors.surfaceContainerLowest, ReiShapes.Inset)
            .clip(ReiShapes.Inset),
    ) {
        val available = maxWidth
        Column(
            Modifier
                .horizontalScroll(rememberScrollState())
                // At least as wide as the bubble, so the header fill spans the table even when its columns are narrow.
                .widthIn(min = available)
                .width(IntrinsicSize.Max),
        ) {
            rows.forEachIndexed { index, (header, cells) ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .then(if (header) Modifier.background(headerFill) else Modifier),
                ) {
                    widths.forEachIndexed { column, width ->
                        Box(Modifier.width(width).padding(horizontal = 12.dp, vertical = 8.dp)) {
                            cells.getOrNull(column)?.let { cell ->
                                InlineMarkdown(cell, env, bold = header, compact = true, align = (cell as? TableCell)?.alignment?.textAlign)
                            }
                        }
                    }
                }
                if (index < rows.lastIndex) HorizontalDivider(color = colors.outlineVariant)
            }
        }
    }
}

@Composable
private fun InlineMarkdown(
    parent: Node,
    env: MarkdownEnv,
    heading: Int = 0,
    bold: Boolean = false,
    compact: Boolean = false,
    align: TextAlign? = null,
) {
    val colors = MaterialTheme.colorScheme
    val today = remember { LocalDate.now().toString() }
    val styles = TextLinkStyles(style = SpanStyle(color = colors.primary, textDecoration = TextDecoration.Underline))
    val code = SpanStyle(fontFamily = FontFamily.Monospace, fontSize = 14.sp, background = colors.surfaceContainerHigh)
    var caretOn by remember { mutableStateOf(true) }
    val showCaret = env.caretBlock === parent
    val scale = LocalMotionScale.current
    if (showCaret && scale > 0f) LaunchedEffect(Unit) {
        while (true) {
            delay(530)
            caretOn = !caretOn
        }
    }
    val rendered: AnnotatedString = buildAnnotatedString {
        fun text(value: String, inLink: Boolean) {
            if (!env.chips || inLink) return append(value)
            for (chip in splitChips(value)) when (chip) {
                is Chip.Plain -> append(chip.text)
                is Chip.Mention -> withStyle(SpanStyle(background = colors.secondaryContainer, color = colors.onSecondaryContainer, fontSize = 0.9.em)) {
                    append("\u2009@${chip.name}\u2009")
                }
                is Chip.Due -> {
                    val overdue = chip.date < today
                    val style = if (overdue) SpanStyle(background = colors.tertiaryContainer, color = colors.onTertiaryContainer, fontSize = 0.9.em)
                    else SpanStyle(background = colors.surfaceContainerHigh, color = colors.onSurface, fontSize = 0.9.em)
                    withStyle(style) { append("\u2009\uD83D\uDCC5 ${chip.date}\u2009") }
                }
            }
        }
        fun render(node: Node, inLink: Boolean = false) {
            fun nested() = children(node).forEach { render(it, inLink) }
            when (node) {
                is MarkdownText -> {
                    var from = 0
                    for (match in if (inLink) emptySequence() else citationUse.findAll(node.literal)) {
                        val label = match.groupValues[1]
                        val number = env.citations[label] ?: continue
                        text(node.literal.substring(from, match.range.first), inLink)
                        withLink(LinkAnnotation.Clickable("citation-$label", styles) { env.cite(label) }) { append("[$number]") }
                        from = match.range.last + 1
                    }
                    text(node.literal.substring(from), inLink)
                }
                is Link -> if (isExternalMarkdownLink(node.destination) || parseReference(node.destination) != null) {
                    withLink(LinkAnnotation.Clickable("link-${node.destination}", styles) { env.open(node.destination) }) {
                        children(node).forEach { render(it, true) }
                    }
                } else nested()
                is StrongEmphasis -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { nested() }
                is Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { nested() }
                is Strikethrough -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { nested() }
                is Code -> withStyle(code) { append(node.literal) }
                is HardLineBreak -> append("\n")
                is SoftLineBreak -> append("\n")
                is HtmlInline -> append(node.literal)
                is MarkdownImage -> append(inlinePlain(node).ifBlank { "Image" })
                else -> nested()
            }
        }
        if (env.struck === parent) withStyle(SpanStyle(color = colors.onSurfaceVariant, textDecoration = TextDecoration.LineThrough)) {
            children(parent).forEach { render(it) }
        } else children(parent).forEach { render(it) }
        if (showCaret) withStyle(SpanStyle(color = if (caretOn || scale <= 0f) colors.primary else androidx.compose.ui.graphics.Color.Transparent)) { append(" ▍") }
    }
    if (rendered.isNotEmpty()) Text(
        rendered,
        if (align != null) Modifier.fillMaxWidth() else Modifier,
        textAlign = align,
        fontWeight = if (bold) FontWeight.SemiBold else null,
        style = when {
            compact -> MaterialTheme.typography.bodyMedium
            heading == 1 -> MaterialTheme.typography.headlineSmall
            heading == 2 -> MaterialTheme.typography.titleLarge
            heading in 3..6 -> MaterialTheme.typography.titleMedium
            else -> MaterialTheme.typography.bodyLarge
        },
    )
}

/** An image in a message or surface: a thumbnail that opens full screen when the chat provides a viewer. */
@Composable
fun MarkdownPicture(api: ReiApi, destination: String, caption: String) {
    val loaded by produceState<Pair<Boolean, ImageBitmap?>>(false to null, destination, api) {
        value = false to null
        value = true to loadPicture(api, destination, 1200)
    }
    val open = LocalPictureOpener.current
    val (done, image) = loaded
    when {
        image != null -> Image(
            image,
            caption.ifBlank { "Image" },
            Modifier
                .fillMaxWidth()
                .heightIn(max = 360.dp)
                .then(if (open != null) Modifier.clickable(onClickLabel = "Open image") { open(PictureSource(destination, caption)) } else Modifier),
        )
        !done -> Surface(
            Modifier.fillMaxWidth().height(160.dp),
            shape = ReiShapes.Inset,
            color = MaterialTheme.colorScheme.surfaceContainerLow,
        ) {
            Box(contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
        }
        else -> Surface(
            Modifier.fillMaxWidth(),
            shape = ReiShapes.Inset,
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Row(
                Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(ReiIcons.Image, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    caption.ifBlank { "Image couldn’t be loaded." },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** Loads a Library image or an external https image, capped at 8 MiB and [maxDimension] pixels. Null when it cannot be shown. */
suspend fun loadPicture(api: ReiApi, destination: String, maxDimension: Int): ImageBitmap? {
    try {
        return withContext(Dispatchers.IO) {
            val file = fileLink.matchEntire(destination)
            val (client, request) = if (file != null) {
                val id = file.groupValues[1]
                val version = file.groupValues[2].ifEmpty {
                    api.request("GET", listOf("api", "files", id)).currentVersion() ?: return@withContext null
                }
                api.client to api.fileRequest(id, version, thumbnail = maxDimension <= 1200)
            } else {
                val url = destination.toHttpUrlOrNull()?.takeIf { isPublicImageUrl(it) }
                    ?: return@withContext null
                // Model-provided external images never receive Rei credentials.
                imageHttp to Request.Builder().url(url).build()
            }
            fetchBitmap(client, request, maxDimension)
        }
    } catch (failure: CancellationException) {
        throw failure
    } catch (_: Exception) {
        // The caption remains available when the content cannot be loaded.
        return null
    }
}

/** Downloads [request] with [client] (capped at 8 MiB) and decodes it no larger than [maxDimension] pixels. Null when it cannot be shown. */
private fun fetchBitmap(client: OkHttpClient, request: Request, maxDimension: Int): ImageBitmap? =
    client.newCall(request).execute().use { response ->
        if (!response.isSuccessful) return@use null
        val source = response.body?.source() ?: return@use null
        val bits = Buffer()
        val maximum = 8L * 1024 * 1024
        while (bits.size <= maximum) if (source.read(bits, 8192) < 0) break
        if (bits.size > maximum) return@use null
        val bytes = bits.readByteArray()
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        if (options.outWidth <= 0 || options.outHeight <= 0) return@use null
        options.inJustDecodeBounds = false
        options.inSampleSize = 1
        while (maxOf(options.outWidth, options.outHeight) / options.inSampleSize > maxDimension) {
            options.inSampleSize *= 2
        }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
    }

/** An image a tool returned, as recorded on its step; sent with Rei's credentials. Null when it cannot be shown. */
suspend fun loadStepImage(api: ReiApi, stepId: String, index: Int, maxDimension: Int): ImageBitmap? =
    try {
        withContext(Dispatchers.IO) {
            fetchBitmap(api.client, api.authenticatedRequest(listOf("api", "steps", stepId, "images", index.toString())).build(), maxDimension)
        }
    } catch (failure: CancellationException) {
        throw failure
    } catch (_: Exception) {
        null
    }

private fun kotlinx.serialization.json.JsonObject.currentVersion(): String? {
    val metadata = get("file") as? kotlinx.serialization.json.JsonObject
    return (metadata?.get("current") as? kotlinx.serialization.json.JsonObject)?.optionalString("versionId")
}

private val TableCell.Alignment.textAlign: TextAlign
    get() = when (this) {
        TableCell.Alignment.LEFT -> TextAlign.Start
        TableCell.Alignment.CENTER -> TextAlign.Center
        TableCell.Alignment.RIGHT -> TextAlign.End
    }

private fun children(node: Node): Sequence<Node> = generateSequence(node.firstChild) { it.next }

private fun inlinePlain(node: Node): String = children(node).joinToString("") {
    when (it) {
        is MarkdownText -> it.literal
        is Code -> it.literal
        else -> inlinePlain(it)
    }
}
