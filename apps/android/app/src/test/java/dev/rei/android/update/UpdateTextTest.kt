package dev.rei.android.update

import android.content.pm.PackageInstaller
import dev.rei.android.R
import dev.rei.android.feature.settings.updateSummary
import dev.rei.android.ui.UiText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateTextTest {
    private val feed = UpdateFeed(2, "0.2.0", "https://e.test/a.apk", "a".repeat(64))

    @Test
    fun settingsRowShowsTheVersionAndTheCheckResult() {
        assertEquals(
            UiText.Resource(R.string.settings_version_status, "0.1.0", UiText.Resource(R.string.settings_update_disabled)),
            updateSummary(false, UpdateState.Idle, "0.1.0"),
        )
        assertEquals(UiText.Resource(R.string.settings_version, "0.1.0"), updateSummary(true, UpdateState.Idle, "0.1.0"))
        assertEquals(
            UiText.Resource(R.string.settings_version_status, "0.1.0", UiText.Resource(R.string.settings_update_checking)),
            updateSummary(true, UpdateState.Checking, "0.1.0"),
        )
        assertEquals(
            UiText.Resource(R.string.settings_version_status, "0.1.0", UiText.Resource(R.string.settings_update_up_to_date)),
            updateSummary(true, UpdateState.UpToDate, "0.1.0"),
        )
        assertEquals(
            UiText.Resource(R.string.settings_version_status, "0.1.0", UiText.Resource(R.string.settings_update_available)),
            updateSummary(true, UpdateState.Available(feed), "0.1.0"),
        )
        assertEquals(
            UiText.Resource(R.string.settings_version_status, "0.1.0", UiText.Resource(R.string.settings_update_updating)),
            updateSummary(true, UpdateState.Downloading(feed, 1, 2), "0.1.0"),
        )
    }

    @Test
    fun downloadPercentIsUnknownUntilTheSizeIs() {
        assertEquals(null, UpdateState.Downloading(feed, 10, -1).percent)
        assertEquals(50, UpdateState.Downloading(feed, 50, 100).percent)
    }

    @Test
    fun installFailuresReadInPlainLanguage() {
        assertEquals(UiText.Resource(R.string.update_install_conflict), installFailureMessage(PackageInstaller.STATUS_FAILURE_CONFLICT, null))
        assertEquals(UiText.Resource(R.string.update_install_storage), installFailureMessage(PackageInstaller.STATUS_FAILURE_STORAGE, null))
        assertEquals(UiText.Resource(R.string.update_install_cancelled), installFailureMessage(PackageInstaller.STATUS_FAILURE_ABORTED, null))
        assertEquals(UiText.Resource(R.string.update_install_failed_detail, "boom"), installFailureMessage(PackageInstaller.STATUS_FAILURE, "boom"))
        assertEquals(UiText.Resource(R.string.update_install_failed), installFailureMessage(PackageInstaller.STATUS_FAILURE, " "))
    }
}
