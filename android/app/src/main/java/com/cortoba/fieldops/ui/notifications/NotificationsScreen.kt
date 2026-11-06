package com.cortoba.fieldops.ui.notifications

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cortoba.fieldops.core.util.formatDateTime
import com.cortoba.fieldops.ui.components.CreamCard
import com.cortoba.fieldops.ui.components.EmptyState
import com.cortoba.fieldops.ui.components.ErrorBanner
import com.cortoba.fieldops.ui.components.LoadingBox
import com.cortoba.fieldops.ui.components.OfflineBanner
import com.cortoba.fieldops.ui.theme.CortobaBrown
import com.cortoba.fieldops.ui.theme.CortobaCoral
import com.cortoba.fieldops.ui.theme.CortobaCream

/**
 * The in-app notification centre.
 *
 * A notification is a pointer to a task, not a task itself: tapping it marks it
 * read, and the representative opens the task from the pickups/deliveries list.
 * That keeps one source of truth for what is outstanding.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotificationsScreen(
    onBack: () -> Unit,
    viewModel: NotificationsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val unread = state.items.count { !it.read }

    Scaffold(
        containerColor = CortobaCream,
        topBar = {
            TopAppBar(
                title = { Text("الإشعارات", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "رجوع")
                    }
                },
                actions = {
                    if (unread > 0) {
                        TextButton(onClick = viewModel::markAllRead) {
                            Text("قراءة الكل", color = CortobaCream)
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = CortobaBrown,
                    titleContentColor = CortobaCream,
                    navigationIconContentColor = CortobaCream,
                ),
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).systemBarsPadding()) {
            when {
                state.loading && state.items.isEmpty() -> LoadingBox(Modifier.fillMaxSize())

                state.items.isEmpty() -> Column {
                    if (state.error != null) {
                        ErrorBanner(state.error!!, modifier = Modifier.padding(16.dp))
                    }
                    EmptyState(
                        title = "لا توجد إشعارات",
                        subtitle = "ستظهر هنا إشعارات إسناد المهام وتوفر كميات للتسليم",
                    )
                }

                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (state.fromCache) {
                        item { OfflineBanner(cachedAt = null) }
                    }

                    items(state.items, key = { it.id }) { notification ->
                        CreamCard(
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Row(verticalAlignment = Alignment.Top) {
                                Box(
                                    modifier = Modifier
                                        .size(38.dp)
                                        .clip(CircleShape)
                                        .background(
                                            if (notification.read) {
                                                MaterialTheme.colorScheme.surfaceVariant
                                            } else {
                                                CortobaCoral.copy(alpha = 0.2f)
                                            },
                                        ),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(
                                        imageVector = Icons.Default.Notifications,
                                        contentDescription = null,
                                        tint = if (notification.read) {
                                            MaterialTheme.colorScheme.onSurfaceVariant
                                        } else {
                                            CortobaBrown
                                        },
                                        modifier = Modifier.size(20.dp),
                                    )
                                }

                                Column(Modifier.weight(1f).padding(start = 12.dp)) {
                                    Text(
                                        text = notification.title,
                                        style = MaterialTheme.typography.titleMedium,
                                        fontWeight = if (notification.read) {
                                            FontWeight.Normal
                                        } else {
                                            FontWeight.Bold
                                        },
                                        color = MaterialTheme.colorScheme.onSurface,
                                    )
                                    if (!notification.body.isNullOrBlank()) {
                                        Text(
                                            text = notification.body,
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            modifier = Modifier.padding(top = 2.dp),
                                        )
                                    }
                                    Text(
                                        text = formatDateTime(notification.createdAt),
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.padding(top = 4.dp),
                                    )
                                }

                                if (!notification.read) {
                                    IconButton(onClick = { viewModel.markRead(notification.id) }) {
                                        Icon(
                                            Icons.Default.CheckCircle,
                                            contentDescription = "تمييز كمقروء",
                                            tint = CortobaBrown,
                                        )
                                    }
                                }
                            }
                        }
                    }

                    item { Spacer(Modifier.height(8.dp)) }
                }
            }
        }
    }
}
