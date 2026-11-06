package com.cortoba.fieldops.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import com.cortoba.fieldops.ui.theme.CortobaCharcoal
import com.cortoba.fieldops.ui.theme.CortobaOutline
import com.cortoba.fieldops.ui.theme.StatusGrey

/**
 * On-screen signature capture.
 *
 * The strokes are kept as paths for drawing and the ink count is reported so the
 * parent can require a non-empty signature before confirming. The signature is
 * evidence attached to the delivery record, not a legal instrument on its own —
 * the audit trail carries the real accountability.
 */
@Composable
fun SignaturePad(
    onSigned: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Completed strokes and the stroke in progress are separate, because a
    // partially drawn path must render while the finger is still down.
    val paths = remember { mutableListOf<Path>() }
    var currentPath by remember { mutableStateOf<Path?>(null) }
    // Path is a mutable object: mutating it does not recompose on its own, so a
    // tick counter drives the redraw while drawing.
    var tick by remember { mutableStateOf(0) }

    Column(modifier = modifier) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "توقيع المستلم",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.weight(1f),
            )
            TextButton(
                onClick = {
                    paths.clear()
                    currentPath = null
                    tick++
                },
            ) {
                Text("مسح", color = StatusGrey)
            }
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(180.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Color.White)
                .padding(2.dp)
                .pointerInput(Unit) {
                    detectDragGestures(
                        onDragStart = { offset ->
                            currentPath = Path().apply { moveTo(offset.x, offset.y) }
                            tick++
                        },
                        onDrag = { change, _ ->
                            currentPath?.lineTo(change.position.x, change.position.y)
                            tick++
                            onSigned()
                        },
                        onDragEnd = {
                            currentPath?.let { paths.add(it) }
                            currentPath = null
                            tick++
                        },
                        onDragCancel = {
                            currentPath?.let { paths.add(it) }
                            currentPath = null
                            tick++
                        },
                    )
                },
        ) {
            Canvas(modifier = Modifier.fillMaxWidth().height(180.dp)) {
                // Reference the tick so a change forces this draw pass.
                @Suppress("UNUSED_EXPRESSION") tick
                val stroke = Stroke(width = 4f, cap = StrokeCap.Round)
                paths.forEach { path ->
                    drawPath(path, color = CortobaCharcoal, style = stroke)
                }
                currentPath?.let { path ->
                    drawPath(path, color = CortobaCharcoal, style = stroke)
                }
            }

            if (paths.isEmpty() && currentPath == null) {
                Text(
                    text = "وقّع هنا بإصبعك",
                    style = MaterialTheme.typography.bodyMedium,
                    color = CortobaOutline,
                    modifier = Modifier.align(Alignment.Center),
                )
            }
        }

        Text(
            text = "التوقيع يُرفق بسجل التسليم مع اسم الموظف والوقت",
            style = MaterialTheme.typography.bodyMedium,
            color = StatusGrey,
            modifier = Modifier.padding(top = 6.dp),
        )
    }
}

/** A small horizontal divider used inside cards. */
@Composable
fun Divider(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(CortobaOutline),
    )
}
