package dev.rei.android.ui.components

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.rei.android.ui.theme.BotTints
import dev.rei.android.ui.theme.LocalMotionScale
import dev.rei.android.ui.theme.ReiTheme

private val DataImage = Regex("^data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$")

/**
 * An agent's look (`Agent.avatar`): a built-in bot (`bot:<id>`; an unknown id shows the first), the owner's own picture
 * (a `data:image` URL) or a short text or emoji badge. [working] makes a bot bob. Pass [name] to give it an accessible
 * name; without one it is decorative.
 */
@Composable
fun AgentAvatar(avatar: String, modifier: Modifier = Modifier, size: Dp = 36.dp, name: String? = null, working: Boolean = false) {
    val a11y = if (name != null) Modifier.semantics { contentDescription = name; role = Role.Image } else Modifier.clearAndSetSemantics { }
    Box(modifier.size(size).then(a11y), contentAlignment = Alignment.Center) {
        when {
            avatar.startsWith("data:") -> {
                val bitmap = remember(avatar) { decodeAvatar(avatar) }
                if (bitmap != null) {
                    Image(bitmap, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(size).clip(CircleShape))
                } else BotAvatar(BotIds.first(), working, Modifier.size(size))
            }
            avatar.startsWith("bot:") -> BotAvatar(avatar.removePrefix("bot:"), working, Modifier.size(size))
            else -> {
                val text = remember(avatar) { badgeText(avatar) }
                Box(
                    Modifier.size(size).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainerLowest),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text,
                        color = MaterialTheme.colorScheme.primary,
                        fontSize = (size.value * (if (text.length > 1) 0.42f else 0.5f)).sp,
                        style = MaterialTheme.typography.labelLarge.copy(fontSize = (size.value * (if (text.length > 1) 0.42f else 0.5f)).sp),
                    )
                }
            }
        }
    }
}

private val BotIds = BotArt.keys.toList()

private fun decodeAvatar(value: String): ImageBitmap? {
    if (!DataImage.matches(value) || value.length > 80_000) return null
    return runCatching {
        val bytes = Base64.decode(value.substringAfter("base64,"), Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
    }.getOrNull()
}

/** The first two letters or emoji (a family emoji is one). */
private fun badgeText(value: String): String {
    val iterator = java.text.BreakIterator.getCharacterInstance()
    iterator.setText(value)
    val parts = mutableListOf<String>()
    var start = iterator.first()
    var end = iterator.next()
    while (end != java.text.BreakIterator.DONE && parts.size < 2) {
        parts += value.substring(start, end)
        start = end
        end = iterator.next()
    }
    return parts.joinToString("")
}

private fun tintOf(id: String, bot: BotTints): Color = when (id) {
    "sprout" -> bot.bonsai
    "round" -> bot.stone
    "antenna" -> bot.lantern
    "cat" -> bot.luckyCat
    "ghost" -> bot.crane
    else -> bot.moonRabbit
}

@Composable
private fun BotAvatar(id: String, working: Boolean, modifier: Modifier) {
    val key = if (id in BotArt) id else BotIds.first()
    val shapes = remember(key) {
        BotArt.getValue(key).map { it to PathParser().parsePathString(it.d).toPath() }
    }
    val bot = ReiTheme.colors.bot
    val disc = MaterialTheme.colorScheme.surfaceContainerLowest
    val tint = tintOf(key, bot)
    val bob = if (working && LocalMotionScale.current > 0f) {
        rememberInfiniteTransition(label = "bot").animateFloat(
            initialValue = 0f,
            targetValue = -2.4f,
            animationSpec = infiniteRepeatable(tween(450), RepeatMode.Reverse),
            label = "bob",
        ).value
    } else 0f
    Canvas(modifier) {
        val unit = size.minDimension / 64f
        drawCircle(disc)
        withTransform({ scale(unit, unit, Offset.Zero); translate(0f, bob) }) {
            shapes.forEach { (shape, path) -> drawBotShape(shape, path, tint, bot) }
        }
    }
}

private fun DrawScope.drawBotShape(shape: BotShape, path: Path, tint: Color, bot: BotTints) {
    val shade = lerp(bot.ink, tint, 0.58f)
    when {
        shape.eye -> drawPath(path, bot.ink)
        shape.fill != null -> {
            drawPath(
                path,
                when (shape.fill) {
                    BotFill.Main -> tint
                    BotFill.Shade -> shade
                    BotFill.Paper -> bot.paper
                    BotFill.Eye -> bot.ink
                },
            )
            if (shape.edge) {
                drawPath(path, lerp(bot.ink, tint, 0.38f), style = Stroke(1.5f, join = StrokeJoin.Round))
            }
        }
        shape.line != null -> {
            val (color, width) = when (shape.line) {
                BotLine.Ink -> bot.ink to 1.8f
                BotLine.Strong -> bot.ink to 3f
                BotLine.Light -> bot.paper to 1.8f
                BotLine.Fold -> lerp(bot.ink, tint, 0.55f) to 1.8f
            }
            drawPath(path, color, style = Stroke(width, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    }
}

@ReiPreviews
@Composable
private fun AgentAvatarPreview() = ReiPreviewSurface {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        BotIds.forEach { AgentAvatar("bot:$it", size = 40.dp) }
        AgentAvatar("🌱", size = 40.dp)
        AgentAvatar("Rx", size = 40.dp)
    }
}
