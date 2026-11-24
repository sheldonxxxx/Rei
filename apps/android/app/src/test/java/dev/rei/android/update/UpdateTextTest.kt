package dev.rei.android.update

import android.content.pm.PackageInstaller
import dev.rei.android.feature.settings.updateSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateTextTest {
    private val feed = UpdateFeed(2, "0.2.0", "https://e.test/a.apk", "a".repeat(64))

    @Test
    fun settingsRowShowsTheVersionAndTheCheckResult() {
        assertEquals("Version 0.1.0 · Update checks are off in this build", updateSummary(false, UpdateState.Idle, "0.1.0"))
        assertEquals("Version 0.1.0", updateSummary(true, UpdateState.Idle, "0.1.0"))
        assertEquals("Version 0.1.0 · Checking…", updateSummary(true, UpdateState.Checking, "0.1.0"))
        assertEquals("Version 0.1.0 · Up to date", updateSummary(true, UpdateState.UpToDate, "0.1.0"))
        assertEquals("Version 0.1.0 · Update available", updateSummary(true, UpdateState.Available(feed), "0.1.0"))
        assertEquals("Version 0.1.0 · Updating…", updateSummary(true, UpdateState.Downloading(feed, 1, 2), "0.1.0"))
    }

    @Test
    fun downloadPercentIsUnknownUntilTheSizeIs() {
        assertEquals(null, UpdateState.Downloading(feed, 10, -1).percent)
        assertEquals(50, UpdateState.Downloading(feed, 50, 100).percent)
    }

    @Test
    fun installFailuresReadInPlainLanguage() {
        assertTrue(installFailureMessage(PackageInstaller.STATUS_FAILURE_CONFLICT, null).contains("signed"))
        assertTrue(installFailureMessage(PackageInstaller.STATUS_FAILURE_STORAGE, null).contains("storage"))
        assertTrue(installFailureMessage(PackageInstaller.STATUS_FAILURE_ABORTED, null).contains("cancelled"))
        assertEquals("The update could not be installed: boom", installFailureMessage(PackageInstaller.STATUS_FAILURE, "boom"))
        assertEquals("The update could not be installed.", installFailureMessage(PackageInstaller.STATUS_FAILURE, " "))
    }
}
