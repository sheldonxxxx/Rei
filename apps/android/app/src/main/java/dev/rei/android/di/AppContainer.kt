package dev.rei.android.di

import android.content.Context
import android.content.SharedPreferences
import dev.rei.android.ReiFirebase
import dev.rei.android.ReiNotifications
import dev.rei.android.data.ChatCatalogRepository
import dev.rei.android.data.CredentialStore
import dev.rei.android.data.CredentialsGateway
import dev.rei.android.data.SessionRepository
import dev.rei.android.data.WorkspaceRepository
import dev.rei.android.feature.chat.ShowDetailsStore
import dev.rei.android.ui.theme.ThemePreferenceStore
import dev.rei.android.update.UpdateManager
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** Dispatchers injected across repositories and ViewModels so tests can override them deterministically. */
data class AppDispatchers(
    val io: CoroutineDispatcher = Dispatchers.IO,
    val default: CoroutineDispatcher = Dispatchers.Default,
    val main: CoroutineDispatcher = Dispatchers.Main.immediate,
)

/**
 * Application-scoped dependency container. Owns long-lived stores, repositories, and the application coroutine scope
 * so feature ViewModels never reach into a God-ViewModel (`ReiViewModel`) or process-wide event singletons.
 */
class AppContainer(context: Context, val dispatchers: AppDispatchers = AppDispatchers()) {
    private val appContext = context.applicationContext
    val appScope: CoroutineScope = CoroutineScope(SupervisorJob() + dispatchers.main)

    val credentials: CredentialsGateway = CredentialStore(appContext)
    val chatPreferences: SharedPreferences = appContext.getSharedPreferences("chat_state", Context.MODE_PRIVATE)
    val themePreferenceStore: ThemePreferenceStore by lazy { ThemePreferenceStore.get(appContext) }
    val showDetailsStore: ShowDetailsStore by lazy { ShowDetailsStore.get(appContext) }
    val updateManager: UpdateManager by lazy { UpdateManager.get(appContext) }

    val workspaceRepository: WorkspaceRepository by lazy {
        WorkspaceRepository(
            scope = appScope,
            apiProvider = { sessionRepository.currentApi },
            onAuthFailure = sessionRepository::reportFailure,
        )
    }

    val sessionRepository: SessionRepository by lazy {
        SessionRepository(
            scope = appScope,
            credentials = credentials,
            dispatchers = dispatchers,
            onSyncPush = { ReiFirebase.sync(appContext) },
            onSignedOut = { ReiNotifications.signedOut(appContext) },
            onOutdated = { updateManager.onClientOutdated() },
            openNotificationIntent = { intent -> ReiNotifications.open(appContext, intent) },
        )
    }

    val chatCatalogRepository: ChatCatalogRepository by lazy {
        ChatCatalogRepository(
            scope = appScope,
            session = sessionRepository,
            preferences = chatPreferences,
            dispatchers = dispatchers,
        )
    }
}
