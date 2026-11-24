package dev.rei.android.ui.theme

import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

/** No square corners. Cards and panels 18dp, bubbles 20dp with a 6dp tail, inputs, chips and buttons fully rounded, sheets 28dp. */
object ReiShapes {
    val Card = RoundedCornerShape(18.dp)
    val Sheet = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)
    val Dialog = RoundedCornerShape(28.dp)

    /** Inputs, chips, buttons, badges. */
    val Pill = CircleShape

    /** Your message: the tail corner is bottom-end. */
    val BubbleUser = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomEnd = 6.dp, bottomStart = 20.dp)

    /** The assistant's reply: the tail corner is bottom-start. */
    val BubbleAssistant = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomEnd = 20.dp, bottomStart = 6.dp)

    /** Inset blocks inside a bubble or card (code, tables, tool rows). */
    val Inset = RoundedCornerShape(12.dp)
}

val ReiMaterialShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = ReiShapes.Card,
    large = ReiShapes.Card,
    extraLarge = ReiShapes.Dialog,
)
