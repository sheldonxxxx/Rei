package dev.rei.android.data

import kotlinx.coroutines.CancellationException

/**
 * Like [runCatching], except coroutine cancellation always escapes so structured concurrency still cancels cleanly.
 */
internal inline fun <R> suspendRunCatching(block: () -> R): Result<R> = try {
    Result.success(block())
} catch (failure: CancellationException) {
    throw failure
} catch (failure: Throwable) {
    Result.failure(failure)
}
